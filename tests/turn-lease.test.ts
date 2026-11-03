import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startTurnWorker } from '../src/agent/turn-worker.js';
import { withPrincipal } from '../src/db/client.js';
import { saveAssistant } from '../src/assistants/repository.js';
import { enqueueJob, requeueStaleJobs } from '../src/jobs/queue.js';
import type { LlmMessage } from '../src/llm/client.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import type { ChatRequest } from './helpers/fake-apisix.js';

const PRINCIPAL_ACTIONS = JSON.stringify([
	'chat',
	'sessions.read_own',
	'memory.read_own',
	'memory.write_own',
	'skills.read_own',
	'contracts.call',
	'contracts.act'
]);

const OWNER = 'leased';
const ROOM = '!room-leased:test.local';
// Shorter than the turn below, which the model answers in 4 s
const LEASE_MS = 1500;
const TURN_MS = 4000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedAssistantRoom(h: TestHarness): Promise<void> {
	const userId = `@twake-space-assistant-${OWNER}:test.local`;
	await withPrincipal(h.db, { id: OWNER }, async (tx) => {
		await tx.sql`insert into principals (id, actions) values (${OWNER}, ${PRINCIPAL_ACTIONS}::jsonb) on conflict do nothing`;
		await saveAssistant(tx, { owner: OWNER, userId, name: 'A', roomId: ROOM });
	});
	await h.db
		.sql`insert into assistant_rooms (room_id, owner, user_id) values (${ROOM}, ${OWNER}, ${userId})`;
}

async function enqueueTurn(h: TestHarness, eventId: string, text: string): Promise<void> {
	await enqueueJob(h.db, {
		kind: 'turn',
		payload: { owner: OWNER, roomId: ROOM, eventId, text },
		dedupKey: `turn:${eventId}`,
		groupKey: `turn:${OWNER}`
	});
}

async function ownerMessages(h: TestHarness): Promise<string[]> {
	const rows = await withPrincipal(
		h.db,
		{ id: OWNER },
		(tx) => tx.sql<{ messages: unknown }[]>`select messages from sessions`
	);
	return rows.flatMap((r) => {
		const messages = (
			typeof r.messages === 'string' ? JSON.parse(r.messages) : r.messages
		) as LlmMessage[];
		return messages.filter((m) => m.role === 'user').map((m) => m.content ?? '');
	});
}

async function tokensSpent(h: TestHarness): Promise<number> {
	const rows = await withPrincipal(
		h.db,
		{ id: OWNER },
		(tx) => tx.sql<{ tokens: string }[]>`select tokens from usage_daily where owner = ${OWNER}`
	);
	return rows.reduce((sum, row) => sum + Number(row.tokens), 0);
}

// The lines of a message logged since a point of the log
function logged(h: TestHarness, since: number, msg: string): Record<string, unknown>[] {
	return h
		.logLines()
		.slice(since)
		.filter((l) => l['msg'] === msg && (msg !== 'turn started' || l['roomId'] === ROOM));
}

describe('a turn that outlives the lease of its job', () => {
	let h: TestHarness;
	const workers: ReturnType<typeof startTurnWorker>[] = [];
	// What the matrix role would have sent: the answers, taken out of the queue as they come
	const sent: string[] = [];
	let stopped = false;
	beforeAll(async () => {
		h = await startTestHarness();
		await seedAssistantRoom(h);
		h.apisix.llm.script = (request: ChatRequest) => ({
			content: `echo: ${request.messages.at(-1)?.content ?? ''}`,
			delayMs: TURN_MS
		});
		// Another replica, as far as the queue is concerned: it takes the jobs whose claim went
		// unrenewed for the lease, and sends what the turns answer
		void (async () => {
			while (!stopped) {
				await requeueStaleJobs(h.db, LEASE_MS);
				const rows = await h.db.sql<
					{ payload: unknown }[]
				>`delete from jobs where kind = 'send' returning payload`;
				for (const row of rows) {
					const p = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as {
						text: string;
					};
					sent.push(p.text);
				}
				await sleep(200);
			}
		})();
	});
	afterEach(async () => {
		for (const worker of workers.splice(0)) await worker.stop();
		await h.db.sql`delete from jobs`;
		await withPrincipal(h.db, { id: OWNER }, async (tx) => {
			await tx.sql`delete from sessions`;
			await tx.sql`delete from usage_daily where owner = ${OWNER}`;
		});
		sent.length = 0;
	});
	afterAll(async () => {
		stopped = true;
		await h.close();
	});

	function startWorker(
		options: {
			leaseRenewMaxMs?: number;
			concurrency?: number;
			turn?: TestHarness['config']['turn'];
			llmTimeoutMs?: number;
			contractsTimeoutMs?: number;
		} = {}
	): void {
		workers.push(
			startTurnWorker({
				db: h.db,
				agent: h.app.agent,
				log: h.app.log,
				locale: h.config.locale,
				turn: h.config.turn,
				requestLifetimeMs: h.config.consent.requestLifetimeMs,
				pollIntervalMs: 100,
				concurrency: 2,
				leaseMs: LEASE_MS,
				...options
			})
		);
	}

	async function untilAnswered(answers: number): Promise<void> {
		for (let i = 0; i < 200; i += 1) {
			const rows = await h.db.sql<
				{ n: number }[]
			>`select count(*)::int as n from jobs where kind = 'turn'`;
			if ((rows[0]?.n ?? 1) === 0 && sent.length >= answers) return;
			await sleep(100);
		}
		throw new Error('the turn never ended');
	}

	it('answers the message once, and keeps it once in the conversation', async () => {
		const since = h.logLines().length;
		startWorker();
		await enqueueTurn(h, '$slow-1', 'take your time');
		await untilAnswered(1);
		// Lets a second run, if any, end too
		await sleep(TURN_MS + 500);
		expect(sent).toEqual(['echo: take your time']);
		expect(logged(h, since, 'turn started')).toHaveLength(1);
		expect(await ownerMessages(h)).toEqual(['take your time']);
		expect(logged(h, since, 'jobs requeued after their lease')).toHaveLength(0);
	});

	it('is answered, kept and counted by the replica that took it over, once its own stopped renewing the lease', async () => {
		const since = h.logLines().length;
		// A replica frozen past its lease, as far as the others know; its turn still ends, later
		startWorker({ leaseRenewMaxMs: 0, concurrency: 1 });
		await enqueueTurn(h, '$slow-2', 'frozen');
		for (let i = 0; logged(h, since, 'turn started').length === 0 && i < 50; i += 1) {
			await sleep(100);
		}
		startWorker();
		await untilAnswered(1);
		await sleep(TURN_MS + 500);
		// The first run woke and answered too, into a job no longer its own: that answer is dropped,
		// the conversation holds the exchange once, and the owner's day is spent once
		expect(logged(h, since, 'turn started')).toHaveLength(2);
		expect(logged(h, since, 'turn lost')).toHaveLength(1);
		expect(sent).toEqual(['echo: frozen']);
		expect(await ownerMessages(h)).toEqual(['frozen']);
		const finished = logged(h, since, 'turn finished');
		expect(finished).toHaveLength(1);
		expect(await tokensSpent(h)).toBe(finished[0]?.['tokens']);
	});

	it('calls no model when its job was taken over while it waited for admission', async () => {
		h.apisix.llm.calls.length = 0;
		const result = await h.app.agent.runOwnerTurn({
			principal: { id: OWNER },
			target: { kind: 'room', roomId: ROOM },
			message: 'taken over',
			log: h.app.log,
			held: async () => false
		});
		expect(result).toEqual({ kind: 'lost' });
		expect(h.apisix.llm.calls).toHaveLength(0);
		expect(await ownerMessages(h)).toEqual([]);
	});

	it('renews its claim for as long as a turn at its limits can take, from the timeouts, and no longer', async () => {
		// No tool call: a turn is five model calls at most, each twice within the model's timeout
		const turn = { ...h.config.turn, maxToolCalls: 0 };
		let since = h.logLines().length;
		startWorker({ turn, llmTimeoutMs: 500, contractsTimeoutMs: 0 });
		await enqueueTurn(h, '$bound-1', 'within the bound');
		await untilAnswered(1);
		await sleep(TURN_MS + 500);
		expect(logged(h, since, 'job lease let go')).toHaveLength(0);
		expect(sent).toEqual(['echo: within the bound']);
		for (const worker of workers.splice(0)) await worker.stop();
		sent.length = 0;
		since = h.logLines().length;
		startWorker({ turn, llmTimeoutMs: 100, contractsTimeoutMs: 0 });
		await enqueueTurn(h, '$bound-2', 'past the bound');
		await untilAnswered(1);
		await sleep(TURN_MS + 500);
		// Each run lets the lease go past the bound, and the next takes the job over, until one ends
		// it: the message is answered once all the same
		expect(logged(h, since, 'job lease let go').length).toBeGreaterThanOrEqual(1);
		expect(logged(h, since, 'turn started').length).toBeGreaterThanOrEqual(2);
		expect(sent).toEqual(['echo: past the bound']);
	});
});
