import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTurnWorker } from '../src/agent/turn-worker.js';
import { saveAssistant } from '../src/assistants/repository.js';
import { withPrincipal } from '../src/db/client.js';
import { enqueueJob, type Job } from '../src/jobs/queue.js';
import { SUGGEST_MAX_AGE_MS, suggestGroup, type SuggestPayload } from '../src/suggestions/job.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { grantConsent } from './helpers/consents.js';
import { MEETING_CATALOG } from './helpers/fake-apisix.js';

// The bug of issue #219, pinned exactly: the handler dropped a suggestion whose 10-minute window had
// closed as "too old", before the runner ever saw it. For a listened conversation that is the only
// pass that reads the invitee's silence and falls back on the owner's own calendar — drop it and the
// owner reads nothing at all. This seeds a suggestion already past its window, carrying the
// availability request and the frozen call a first pass would have written, and checks that the one
// pass still runs and still proposes. Its window is spent for real (payload.at and asked_at are both
// ten minutes back), so the guard is what decides the outcome — not the injected clock a suite can
// fast-forward, which the runner reads but the handler does not.

const BOB = 'bob@test.local';
const ROOM = '!listened:test.local';
const QUOTE = 'ok pour lundi 9h30 ?';
const PRINCIPAL_ACTIONS = JSON.stringify(['chat', 'contracts.call', 'contracts.act']);

const roomOf = (owner: string): string => `!${owner.split('@')[0]}-assistant:test.local`;

function payloadOf<T>(row: { payload: unknown }): T {
	return (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as T;
}

describe('a listened suggestion whose window is already spent when its job runs', () => {
	let h: TestHarness;
	let worker: ReturnType<typeof startTurnWorker>;

	beforeAll(async () => {
		h = await startTestHarness({
			env: { SUGGESTIONS_ENABLED: 'true', MATRIX_SERVER_NAME: 'test.local' }
		});
		h.apisix.contracts.spec = MEETING_CATALOG;
		expect(await h.app.agent.contracts.load()).toBe(6);
		h.apisix.contracts.handler = (call) =>
			call.path.endsWith('/freebusy')
				? { status: 200, body: { start: '', end: '', free: true, busy: [] } }
				: { status: 200, body: { slots: [] } };
		worker = startTurnWorker({
			db: h.db,
			agent: h.app.agent,
			log: h.app.log,
			locale: h.config.locale,
			turn: h.config.turn,
			requestLifetimeMs: h.config.consent.requestLifetimeMs,
			suggestions: { config: h.config, space: null },
			pollIntervalMs: 3_600_000
		});
	});
	afterAll(async () => {
		if (worker !== undefined) await worker.stop();
		if (h !== undefined) await h.close();
	});

	it('still runs the pass that falls back, rather than dropping the job as too old', async () => {
		const owner = 'erin@test.local';
		const userId = '@twake-space-assistant-erin:test.local';
		await withPrincipal(h.db, { id: owner }, async (tx) => {
			await tx.sql`insert into principals (id, actions) values (${owner}, ${PRINCIPAL_ACTIONS}::jsonb)`;
			await saveAssistant(tx, { owner, userId, name: 'Jarvis', roomId: roomOf(owner) });
		});
		await h.db.sql`
			insert into assistant_rooms (room_id, owner, user_id) values (${roomOf(owner)}, ${owner}, ${userId})`;
		await grantConsent(h.db, owner, 'calendar', 'read');

		const eventId = '$spent-window-1';
		const at = Date.now() - SUGGEST_MAX_AGE_MS - 60_000;
		const askedAt = new Date(at);
		const start = new Date(Date.now() + 3 * 86_400_000).toISOString();
		const end = new Date(Date.now() + 3 * 86_400_000 + 30 * 60_000).toISOString();
		// The frozen create_meeting call a first pass wrote, at the owner's own first free slot, which
		// the fallback proposes as it stands
		const frozen = await withPrincipal(
			h.db,
			{ id: owner },
			(tx) =>
				tx.sql<{ id: string }[]>`
				insert into pending_calls (owner, tool, contract, domain, level, reasons, arguments)
				values (${owner}, 'create_meeting', 'calendar.meeting.create.v1', 'calendar', 'write', '[]'::jsonb,
					${JSON.stringify({ body: { title: 'Point lundi', start, end, attendees: [BOB] } })}::jsonb)
				returning id`
		);
		const pendingCallId = frozen[0]?.id ?? '';
		expect(pendingCallId).not.toBe('');
		// The request that pass wrote, still unanswered: the invitee never granted the sharing
		await withPrincipal(
			h.db,
			{ id: owner },
			(tx) =>
				tx.sql`insert into availability_requests
				(organizer, invitee, room_id, event_id, asked_at, period_start, asked_minutes, duration_ms, pending_call_id)
				values (${owner}, ${BOB}, ${ROOM}, ${eventId}, ${askedAt}, ${start.slice(0, 10)}, null, ${30 * 60_000},
					${pendingCallId})`
		);

		const payload: SuggestPayload = {
			owner,
			roomId: ROOM,
			eventId,
			at,
			quoted: [{ author: '@bob:test.local', email: BOB, text: QUOTE }],
			listened: true,
			other: BOB
		};
		await enqueueJob(h.db, {
			kind: 'suggest',
			payload,
			dedupKey: `suggest:${eventId}:${owner}`,
			groupKey: suggestGroup(owner)
		});
		const rows = await h.db.sql<{ id: string; attempts: number; deferrals: number }[]>`
			select id, attempts, deferrals from jobs where kind = 'suggest' and status = 'queued'`;
		const job: Job = {
			id: Number(rows[0]?.id),
			kind: 'suggest',
			payload,
			attempts: rows[0]?.attempts ?? 0,
			deferrals: rows[0]?.deferrals ?? 0,
			deferredForMs: 0
		};
		await worker.pass(job);

		// The pass ran rather than being dropped as too old: the model never saw it, and the owner reads
		// their fallback proposal naming the invitee whose availability could not be seen
		expect(h.apisix.llm.calls).toHaveLength(0);
		const sends = await h.db.sql<{ payload: unknown }[]>`
			select payload from jobs where kind = 'send' order by id`;
		const texts = sends
			.map((r) => payloadOf<{ roomId: string; text: string }>(r))
			.filter((p) => p.roomId === roomOf(owner))
			.map((p) => p.text);
		expect(texts).toHaveLength(1);
		expect(texts[0]).toContain(BOB);
		expect(texts[0]).toContain('could not see the availability');
		// The question carries the meeting it proposes, from the channel it was listened in
		const marked = sends
			.map((r) => payloadOf<{ roomId: string; questionMarker?: unknown }>(r))
			.find((p) => p.roomId === roomOf(owner));
		expect(marked?.questionMarker).toMatchObject({
			meeting: { roomId: ROOM, invitees: ['@bob:test.local'], title: 'Point lundi' }
		});
	});
});
