import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTurnWorker } from '../src/agent/turn-worker.js';
import { saveAssistant } from '../src/assistants/repository.js';
import { withPrincipal } from '../src/db/client.js';
import { enqueueJob, type Job } from '../src/jobs/queue.js';
import { SUGGEST_MAX_AGE_MS, suggestGroup, type SuggestPayload } from '../src/suggestions/job.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { grantConsent } from './helpers/consents.js';
import { MEETING_CATALOG, type ChatRequest, type ScriptedReply } from './helpers/fake-apisix.js';

interface Waiting {
	readonly id: string;
	readonly tool: string;
}

// The other member of the listened room. Never an owner of a suite below: a suggestion whose owner
// is also its invitee settles as nobody_else, the same person never being a colleague of themselves
const INVITEE = 'bob@test.local';
// An encrypted direct room the owner invited their assistant into
const ROOM = '!listened:test.local';
const QUOTE = 'ok pour lundi 9h30 ?';

const PRINCIPAL_ACTIONS = JSON.stringify(['chat', 'contracts.call', 'contracts.act']);

// The harness's own tool, the only one a listened conversation's model gets
const PROPOSE = 'propose_meeting';

// The day the model names, as a calendar day: three days after the moment of its own prompt, so
// that the slot it asks for is never behind the search's floor whatever the clock of the run
function dayFromPrompt(system: string, offsetDays: number): string {
	const iso = /ISO 8601: (\d{4}-\d{2}-\d{2})T/.exec(system)?.[1];
	const base = iso === undefined ? new Date() : new Date(`${iso}T12:00:00Z`);
	return new Date(base.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

// A literal model: on a listened conversation it names a day and a time, and says one line with it
const proposingModel = (request: ChatRequest): ScriptedReply => {
	const last = request.messages.at(-1);
	if (last?.role === 'tool') return { content: 'NONE' };
	const system = request.messages[0]?.content ?? '';
	return {
		content: 'Lundi vous convient.',
		toolCalls: [
			{
				id: 'call_propose',
				type: 'function',
				function: {
					name: PROPOSE,
					arguments: JSON.stringify({
						day: dayFromPrompt(system, 3),
						time: '10:00',
						duration: 30,
						title: 'Point lundi'
					})
				}
			}
		]
	};
};

// A gateway that answers nothing: the model call times out, as the dev one did at +203 s
const failingModel = (): ScriptedReply => ({ failWith: 503 });

// The room an owner's assistant writes to them in
const roomOf = (owner: string): string => `!${owner.split('@')[0]}-assistant:test.local`;

// A payload of the queue, as the jobs table keeps it
function payloadOf<T>(row: { payload: unknown }): T {
	return (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as T;
}

describe('a listened suggestion that waits for an availability answer', () => {
	let h: TestHarness;
	let worker: ReturnType<typeof startTurnWorker>;
	let events = 0;
	// The present the suggestion reads for the request's window, moved by a suite alone: the real
	// clock keeps the queue's own run_after, which the database reads
	let moment: Date | null = null;
	const clock = { now: (): Date => moment ?? new Date() };

	beforeAll(async () => {
		h = await startTestHarness({
			env: { SUGGESTIONS_ENABLED: 'true', MATRIX_SERVER_NAME: 'test.local' },
			clock
		});
		h.apisix.contracts.spec = MEETING_CATALOG;
		expect(await h.app.agent.contracts.load()).toBe(6);
		// The owner's calendar is free everywhere, and no slot search finds anything: the one
		// candidate is the time the model asked for
		h.apisix.contracts.handler = (call) =>
			call.path.endsWith('/freebusy')
				? { status: 200, body: { start: '', end: '', free: true, busy: [] } }
				: { status: 200, body: { slots: [] } };
		h.apisix.llm.script = proposingModel;
		worker = startTurnWorker({
			db: h.db,
			agent: h.app.agent,
			log: h.app.log,
			locale: h.config.locale,
			turn: h.config.turn,
			requestLifetimeMs: h.config.consent.requestLifetimeMs,
			suggestions: { config: h.config, space: null },
			// Nothing is claimed by a poll: every pass below is driven by hand, so that how many
			// passes a suggestion takes never depends on the speed of the host
			pollIntervalMs: 3_600_000,
			clock
		});
	});
	afterAll(async () => {
		if (worker !== undefined) await worker.stop();
		if (h !== undefined) await h.close();
	});

	// An owner whose assistant writes to them in a room of its own and may read their calendar, as
	// the matrix role leaves them
	async function ownerNamed(name: string): Promise<string> {
		const owner = `${name}@test.local`;
		const userId = `@twake-space-assistant-${name}:test.local`;
		await withPrincipal(h.db, { id: owner }, async (tx) => {
			await tx.sql`insert into principals (id, actions) values (${owner}, ${PRINCIPAL_ACTIONS}::jsonb)`;
			await saveAssistant(tx, { owner, userId, name: 'Jarvis', roomId: roomOf(owner) });
		});
		await h.db.sql`
			insert into assistant_rooms (room_id, owner, user_id) values (${roomOf(owner)}, ${owner}, ${userId})`;
		await grantConsent(h.db, owner, 'calendar', 'read');
		return owner;
	}

	// A suggestion of a listened conversation, as the matrix role queues it: the message both
	// members see, and the other member read in the room whether they wrote it or not
	async function suggestListened(owner: string, at = Date.now()): Promise<SuggestPayload> {
		events += 1;
		const payload: SuggestPayload = {
			owner,
			roomId: ROOM,
			eventId: `$listened-${events}`,
			at,
			quoted: [{ author: '@bob:test.local', email: INVITEE, text: QUOTE }],
			listened: true,
			other: INVITEE
		};
		await enqueueJob(h.db, {
			kind: 'suggest',
			payload,
			dedupKey: `suggest:${payload.eventId}:${owner}`,
			groupKey: suggestGroup(owner)
		});
		return payload;
	}

	// The job as the queue holds it, as a worker would have claimed it. A deferred job comes back
	// under a new id, so it is always found by the message it carries, never by the id it had
	async function jobOf(payload: SuggestPayload): Promise<Job> {
		const rows = await h.db.sql<
			{ id: string; kind: string; payload: unknown; attempts: number; deferrals: number }[]
		>`select id, kind, payload, attempts, deferrals from jobs
			where kind = 'suggest' and status in ('queued', 'deferred', 'running') order by id`;
		const found = rows.find(
			(row) => payloadOf<{ eventId: string }>(row).eventId === payload.eventId
		);
		if (found === undefined) throw new Error(`no job for ${payload.eventId}`);
		return {
			id: Number(found.id),
			kind: found.kind as Job['kind'],
			payload,
			attempts: found.attempts,
			deferrals: found.deferrals,
			deferredForMs: 0
		};
	}

	// One pass of the suggestion's own handler, as the worker runs it, and what became of the job: a
	// job the handler settled is deleted outright, so a row that is gone is a pass that is done
	async function pass(payload: SuggestPayload): Promise<string> {
		const job = await jobOf(payload);
		await worker.pass(job);
		const rows = await h.db.sql<{ status: string }[]>`select status from jobs where id = ${job.id}`;
		return rows[0]?.status ?? 'done';
	}

	// How many calls the model has been given so far. The harness serves every suite of this file, so
	// a suite counts from the moment it starts, never from zero
	const callsSoFar = (): number => h.apisix.llm.calls.length;

	// The calls the owner is asked about, as their client lists them
	async function waitingCalls(owner: string): Promise<Waiting[]> {
		return withPrincipal(h.db, { id: owner }, async (tx) => {
			const rows = await tx.sql<{ id: string; tool: string }[]>`
				select id, tool from pending_calls where owner = ${owner} and status = 'open' order by id`;
			return rows.map((row) => ({ id: row.id, tool: row.tool }));
		});
	}

	// The availability requests this room holds, as the organizer's code keeps them: the row is a
	// party's own, so it is read under the organizer's principal
	async function requests(owner: string) {
		return withPrincipal(
			h.db,
			{ id: owner },
			(tx) =>
				tx.sql<{ id: string; answer: unknown; pending_call_id: string }[]>`
				select id, answer, pending_call_id from availability_requests where organizer = ${owner}`
		);
	}

	// The question the harness wrote in the owner's own room, oldest first
	async function written(owner: string): Promise<string[]> {
		const rows = await h.db.sql<{ payload: unknown }[]>`
			select payload from jobs where kind = 'send' order by id`;
		return rows
			.map((r) => payloadOf<{ roomId: string; text: string }>(r))
			.filter((p) => p.roomId === roomOf(owner))
			.map((p) => p.text);
	}

	it('runs the model once, then re-reads the request alone, and freezes one call only', async () => {
		const alice = await ownerNamed('alice');
		const before = callsSoFar();
		const message = await suggestListened(alice);
		// The first pass: the model names the day, the harness freezes the meeting at its own first
		// free slot, and the request for the invitee's assistant is written
		expect(await pass(message)).toBe('deferred');
		expect(callsSoFar() - before).toBe(1);
		const asked = await requests(alice);
		expect(asked).toHaveLength(1);
		const frozen = asked[0]?.pending_call_id;
		expect(await waitingCalls(alice)).toEqual([{ id: frozen, tool: 'create_meeting' }]);
		// Four more passes, as the handler would take within the window: the request still waits for
		// its invitee, and not one of them reaches the model, nor freezes another call
		for (let i = 0; i < 4; i += 1) expect(await pass(message)).toBe('deferred');
		expect(callsSoFar() - before).toBe(1);
		expect(await waitingCalls(alice)).toEqual([{ id: frozen, tool: 'create_meeting' }]);
		expect(await requests(alice)).toHaveLength(1);
		// No question was asked and nothing was written while the answer is still to come
		expect(await written(alice)).toEqual([]);
	});

	it('falls back on the owner’s calendar alone once the window closes with no answer', async () => {
		const erin = await ownerNamed('erin');
		const before = callsSoFar();
		const message = await suggestListened(erin);
		expect(await pass(message)).toBe('deferred');
		expect(callsSoFar() - before).toBe(1);
		// The window closes on the invitee's silence: the harness moves its own present ten minutes
		// on, and the pass that follows reads the request it already holds
		moment = new Date(Date.now() + SUGGEST_MAX_AGE_MS + 1);
		expect(await pass(message)).toBe('done');
		// The model never saw the second pass, and the owner reads their proposal all the same: the
		// harness's own sentence, saying the invitee's availability could not be seen
		expect(callsSoFar() - before).toBe(1);
		const sentences = await written(erin);
		expect(sentences).toHaveLength(1);
		expect(sentences[0]).toContain(INVITEE);
		expect(sentences[0]).toContain('could not see the availability');
		expect(await waitingCalls(erin)).toEqual([{ id: expect.any(String), tool: 'create_meeting' }]);
		expect(
			await withPrincipal(
				h.db,
				{ id: erin },
				(tx) => tx.sql`select 1 from suggestions where owner = ${erin}`
			)
		).toHaveLength(1);
		moment = null;
	});

	it('reaches the fallback, rather than abandoning, once the model call itself fails', async () => {
		const carol = await ownerNamed('carol');
		h.apisix.llm.script = failingModel;
		try {
			const message = await suggestListened(carol);
			// The model times out: the suggestion asks to be tried again within its window rather
			// than deciding nothing, and writes no call of its own meanwhile
			expect(await pass(message)).toBe('deferred');
			expect(await waitingCalls(carol)).toEqual([]);
			// The gateway is back. The try that follows reaches the model, which settles the message
			// as any first pass would: a request for the invitee's assistant, and one frozen call
			h.apisix.llm.script = proposingModel;
			expect(await pass(message)).toBe('deferred');
			const asked = await requests(carol);
			expect(asked).toHaveLength(1);
			expect(await waitingCalls(carol)).toEqual([
				{ id: asked[0]?.pending_call_id, tool: 'create_meeting' }
			]);
		} finally {
			h.apisix.llm.script = proposingModel;
		}
	});

	it('says nothing, and freezes nothing, once the model fails and the window is spent', async () => {
		const dave = await ownerNamed('dave');
		h.apisix.llm.script = failingModel;
		try {
			const message = await suggestListened(dave);
			expect(await pass(message)).toBe('deferred');
			// The gateway stays down until the window closes: the harness moves its own present ten
			// minutes on, and the suggestion decides nothing rather than freezing a call nobody asked for
			moment = new Date(Date.now() + SUGGEST_MAX_AGE_MS);
			expect(await pass(message)).toBe('done');
			expect(await waitingCalls(dave)).toEqual([]);
			expect(await requests(dave)).toEqual([]);
			expect(await written(dave)).toEqual([]);
		} finally {
			h.apisix.llm.script = proposingModel;
			moment = null;
		}
	});

	// The drop this flow must still make. A suggestion that never made an availability request is
	// dropped the moment its window closes, as before, and reaches neither the model nor the owner.
	// This is the case the window's own length makes load-bearing: the job's window and the request's
	// are the same ten minutes, so the pass that reads the invitee's silence is the one the age check
	// would otherwise delete. Only a suggestion already carrying a request is let through.
	it('drops an expired suggestion that never asked for availability, without reaching the model', async () => {
		const frank = await ownerNamed('frank');
		h.apisix.llm.script = failingModel;
		try {
			const message = await suggestListened(frank);
			// The first pass fails at the model and asks for another try, as a listened suggestion does
			expect(await pass(message)).toBe('deferred');
			// The window closes before the gateway comes back: this one asked for no availability, so
			// the pass that follows is dropped rather than run
			moment = new Date(Date.now() + SUGGEST_MAX_AGE_MS + 1);
			h.apisix.llm.script = proposingModel;
			expect(await pass(message)).toBe('done');
			expect(await written(frank)).toEqual([]);
			expect(await requests(frank)).toEqual([]);
			expect(await waitingCalls(frank)).toEqual([]);
		} finally {
			h.apisix.llm.script = proposingModel;
			moment = null;
		}
	});
});
