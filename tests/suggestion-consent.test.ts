import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTurnWorker } from '../src/agent/turn-worker.js';
import { saveAssistant } from '../src/assistants/repository.js';
import { recordRequestEvent, supersedeRequests } from '../src/consents/repository.js';
import { withPrincipal } from '../src/db/client.js';
import { enqueueJob } from '../src/jobs/queue.js';
import {
	SUGGEST_MAX_AGE_MS,
	SUGGEST_RECHECK_MS,
	suggestGroup,
	type SuggestPayload
} from '../src/suggestions/job.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient, type TestClient } from './helpers/client.js';
import { eventually } from './helpers/feedback.js';
import { MEETING_CATALOG, type ChatRequest, type ScriptedReply } from './helpers/fake-apisix.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Waiting {
	readonly id: string;
	readonly tool: string;
}

const BOB = 'bob@test.local';
const CHANNEL = '!channel:test.local';
// What the owner answers Bob in the channel, which only the suggestion's model may read
const QUOTE = 'ok pour lundi 9h30 ?';

const PRINCIPAL_ACTIONS = JSON.stringify(['chat', 'contracts.call', 'contracts.act']);

// The model, as a literal one: it prepares a meeting on Monday with Bob, then says nothing more
const proposeMonday = (request: ChatRequest): ScriptedReply =>
	request.messages.at(-1)?.role === 'tool'
		? { content: 'NONE' }
		: {
				content: 'Lundi vous convient.',
				toolCalls: [
					{
						id: 'call_monday',
						type: 'function',
						function: {
							name: 'create_meeting',
							arguments: JSON.stringify({
								body: {
									title: 'Point lundi',
									start: '2026-10-12T09:30:00+02:00',
									end: '2026-10-12T09:45:00+02:00',
									attendees: [BOB]
								}
							})
						}
					}
				]
			};

// The room an owner's assistant writes to them in
const roomOf = (owner: string): string => `!${owner.split('@')[0]}-assistant:test.local`;

// A payload of the queue, as the jobs table keeps it
function payloadOf<T>(row: { payload: unknown }): T {
	return (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as T;
}

describe('a suggestion whose owner never let their assistant read their calendar', () => {
	let h: TestHarness;
	let api: TestClient;
	let worker: ReturnType<typeof startTurnWorker>;
	let events = 0;

	beforeAll(async () => {
		h = await startTestHarness({ env: { SUGGESTIONS_ENABLED: 'true' } });
		api = makeClient(h);
		h.apisix.contracts.spec = MEETING_CATALOG;
		expect(await h.app.agent.contracts.load()).toBe(6);
		h.apisix.llm.script = proposeMonday;
		worker = startTurnWorker({
			db: h.db,
			agent: h.app.agent,
			log: h.app.log,
			locale: h.config.locale,
			turn: h.config.turn,
			requestLifetimeMs: h.config.consent.requestLifetimeMs,
			suggestions: { config: h.config, space: null },
			pollIntervalMs: 100
		});
	});
	afterAll(async () => {
		if (worker !== undefined) await worker.stop();
		if (h !== undefined) await h.close();
	});

	// An owner whose assistant writes to them in a room of its own, as the matrix role leaves them
	async function ownerNamed(name: string): Promise<string> {
		const owner = `${name}@test.local`;
		const userId = `@twake-space-assistant-${name}:test.local`;
		await withPrincipal(h.db, { id: owner }, async (tx) => {
			await tx.sql`insert into principals (id, actions) values (${owner}, ${PRINCIPAL_ACTIONS}::jsonb)`;
			await saveAssistant(tx, { owner, userId, name: 'Jarvis', roomId: roomOf(owner) });
		});
		await h.db.sql`
			insert into assistant_rooms (room_id, owner, user_id) values (${roomOf(owner)}, ${owner}, ${userId})`;
		return owner;
	}

	// A suggestion for the owner, as the matrix role queues it: Bob's message, then theirs, which
	// matched
	async function suggest(owner: string, overrides: Partial<SuggestPayload> = {}): Promise<void> {
		events += 1;
		const payload: SuggestPayload = {
			owner,
			roomId: CHANNEL,
			eventId: `$message-${events}`,
			at: Date.now(),
			quoted: [
				{ author: '@bob:test.local', email: BOB, text: 'On se voit quand ?' },
				{ author: `@${owner.split('@')[0]}:test.local`, email: owner, text: QUOTE }
			],
			...overrides
		};
		await enqueueJob(h.db, {
			kind: 'suggest',
			payload,
			dedupKey: `suggest:${payload.eventId}:${owner}`,
			groupKey: suggestGroup(owner)
		});
	}

	// What the assistant was to write in the owner's room, oldest first
	async function written(owner: string): Promise<string[]> {
		const rows = await h.db.sql<{ payload: unknown }[]>`
			select payload from jobs where kind = 'send' order by id`;
		return rows
			.map((r) => payloadOf<{ roomId: string; text: string }>(r))
			.filter((p) => p.roomId === roomOf(owner))
			.map((p) => p.text);
	}

	// The owner's suggestions still to make, quotes included
	async function waiting(owner: string): Promise<string[]> {
		const rows = await h.db.sql<{ payload: unknown }[]>`
			select payload from jobs where kind = 'suggest' order by id`;
		return rows
			.filter((r) => payloadOf<{ owner: string }>(r).owner === owner)
			.map((r) => JSON.stringify(r.payload));
	}

	// The calls that wait for the owner, as their client lists them
	async function waitingCalls(owner: string): Promise<Waiting[]> {
		const { body } = await api.get<{ pending_calls: Waiting[] }>(owner, '/v1/pending-calls');
		return body.pending_calls;
	}

	// The question asked about a call, once the matrix role wrote it in the owner's room
	async function askedInTheirRoom(owner: string, pendingCallId: string): Promise<void> {
		await withPrincipal(h.db, { id: owner }, (tx) =>
			recordRequestEvent(tx, pendingCallId, `$question-${pendingCallId}`, roomOf(owner))
		);
	}

	// The question a suggestion asked the owner, once it went out
	async function questionTo(owner: string): Promise<string> {
		const asked = await eventually(async () =>
			(await waitingCalls(owner)).find((c) => c.tool === 'suggest_after_consent')
		);
		if (asked === undefined) throw new Error('no question was asked');
		return asked.id;
	}

	const quotedToTheModel = (owner: string): boolean =>
		h.apisix.llm.calls.some((c) => {
			const told = JSON.stringify(c.request.messages);
			return told.includes(QUOTE) && told.includes(owner);
		});

	it('asks her, naming Bob and quoting nothing, and keeps the quotes in the suggestion alone, which waits', async () => {
		const alice = await ownerNamed('alice');
		await suggest(alice);
		const asked = await eventually(async () => (await written(alice))[0]);
		expect(asked).toContain(BOB);
		expect(asked).not.toContain(QUOTE);
		const kept = await withPrincipal(
			h.db,
			{ id: alice },
			(tx) => tx.sql`select tool, arguments, request_text from pending_calls`
		);
		expect(kept).toHaveLength(1);
		expect(JSON.stringify(kept)).not.toContain(QUOTE);
		expect(h.apisix.llm.calls).toHaveLength(0);
		await sleep(1000);
		const left = await waiting(alice);
		expect(left).toHaveLength(1);
		expect(left[0]).toContain(QUOTE);
	});

	it('goes on once she says yes, even a while after, and keeps nothing of the quotes', async () => {
		const alice = 'alice@test.local';
		const id = await questionTo(alice);
		await askedInTheirRoom(alice, id);
		// She answers once the suggestion looked for her answer already
		await sleep(SUGGEST_RECHECK_MS + 1000);
		expect((await api.post(alice, `/v1/pending-calls/${id}/approve`, {})).status).toBe(202);
		expect(await eventually(() => quotedToTheModel(alice))).toBe(true);
		const meeting = await eventually(async () =>
			(await waitingCalls(alice)).find((c) => c.tool === 'create_meeting')
		);
		expect(meeting).toBeDefined();
		expect(await eventually(async () => (await waiting(alice)).length === 0)).toBe(true);
		const metrics = (await h.app.inject({ method: 'GET', url: '/metrics' })).body;
		expect(metrics).toMatch(
			/harness_consent_replays_total\{[^}]*domain="calendar"[^}]*outcome="ok"/
		);
		// Her room's conversation holds the question and her yes, never a quote
		const sessions = await withPrincipal(
			h.db,
			{ id: alice },
			(tx) => tx.sql`select messages from sessions`
		);
		expect(JSON.stringify(sessions)).not.toContain(QUOTE);
	});

	it('drops the suggestion and its quotes at her no, and never asks her again', async () => {
		const carol = await ownerNamed('carol');
		await suggest(carol);
		const id = await questionTo(carol);
		await askedInTheirRoom(carol, id);
		expect((await api.post(carol, `/v1/pending-calls/${id}/refuse`, {})).status).toBeLessThan(300);
		expect(await eventually(async () => (await waiting(carol)).length === 0)).toBe(true);
		await suggest(carol, { roomId: '!another-channel:test.local' });
		expect(await eventually(async () => (await waiting(carol)).length === 0)).toBe(true);
		// Her room has the question and the harness's answer to her no, and no question again
		expect((await written(carol)).filter((text) => text.includes(BOB))).toHaveLength(1);
		expect(quotedToTheModel(carol)).toBe(false);
	});

	it('asks nothing more while her own request to read her calendar waits, and goes on at her yes to it', async () => {
		const dave = await ownerNamed('dave');
		const own = await api.tool(dave, 'find_meeting_slots', {
			email: [dave],
			duration: 30,
			start: '2026-10-12T08:00:00+02:00',
			end: '2026-10-12T18:00:00+02:00'
		});
		expect(own.status).toBe(202);
		await suggest(dave);
		await sleep(SUGGEST_RECHECK_MS + 1000);
		const calls = await waitingCalls(dave);
		expect(calls.map((c) => c.tool)).toEqual(['find_meeting_slots']);
		expect(await written(dave)).toEqual([]);
		expect(await waiting(dave)).toHaveLength(1);
		expect((await api.post(dave, `/v1/pending-calls/${calls[0]?.id}/approve`, {})).status).toBe(
			200
		);
		expect(await eventually(() => quotedToTheModel(dave))).toBe(true);
	});

	it('gives up, rather than asking again, once a newer question in her room replaced hers', async () => {
		const erin = await ownerNamed('erin');
		await suggest(erin);
		const id = await questionTo(erin);
		await askedInTheirRoom(erin, id);
		// The matrix role asks her something newer in her room
		await withPrincipal(h.db, { id: erin }, (tx) =>
			supersedeRequests(tx, erin, roomOf(erin), '00000000-0000-4000-8000-000000000000')
		);
		expect(await eventually(async () => (await waiting(erin)).length === 0)).toBe(true);
		expect(await waitingCalls(erin)).toEqual([]);
		expect(await written(erin)).toHaveLength(1);
	});

	it('drops the suggestion and its quotes ten minutes after the message, whatever she answers later', async () => {
		const frank = await ownerNamed('frank');
		await suggest(frank, { at: Date.now() - SUGGEST_MAX_AGE_MS + 2000 });
		await questionTo(frank);
		expect(await eventually(async () => (await waiting(frank)).length === 0, 8000)).toBe(true);
		expect((await waitingCalls(frank)).map((c) => c.tool)).toEqual(['suggest_after_consent']);
	});

	it('asks nothing for a message of hers alone', async () => {
		const gina = await ownerNamed('gina');
		await suggest(gina, {
			quoted: [{ author: '@gina:test.local', email: gina, text: QUOTE }]
		});
		expect(await eventually(async () => (await waiting(gina)).length === 0)).toBe(true);
		expect(await waitingCalls(gina)).toEqual([]);
		expect(await written(gina)).toEqual([]);
	});

	it('is no tool of the API, nor of the model, whatever it is given', async () => {
		const harry = await ownerNamed('harry');
		const before = await h.db.sql`select 1 from jobs where kind = 'suggest'`;
		expect((await api.tool(harry, 'suggest_after_consent', {})).status).toBe(404);
		expect(h.app.agent.tools.find('suggest_after_consent')).toBeNull();
		expect(await h.db.sql`select 1 from jobs where kind = 'suggest'`).toHaveLength(before.length);
	});
});
