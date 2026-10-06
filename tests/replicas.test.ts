import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTurnWorker } from '../src/agent/turn-worker.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeDb, withPrincipal } from '../src/db/client.js';
import { saveAssistant } from '../src/assistants/repository.js';
import { enqueueJob } from '../src/jobs/queue.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient, type TestClient } from './helpers/client.js';
import type { ChatRequest } from './helpers/fake-apisix.js';

const PRINCIPAL_ACTIONS = JSON.stringify([
	'chat',
	'sessions.read_own',
	'memory.read_own',
	'memory.write_own',
	'skills.read_own',
	'contracts.call'
]);

// Settings shared by every replica of this suite
const ENV = { ADMISSION_USER_PER_MINUTE: '6' };

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Replica {
	readonly app: Awaited<ReturnType<typeof buildApp>>;
	readonly client: TestClient;
	readonly logLines: () => Record<string, unknown>[];
	readonly worker: ReturnType<typeof startTurnWorker>;
	stop(): Promise<void>;
}

// A second api replica on the same database, with its own turn worker
async function startReplica(h: TestHarness): Promise<Replica> {
	const config = loadConfig({
		HARNESS_ROLE: 'api',
		DATABASE_URL: h.config.databaseUrl,
		AUTH_JWKS_URL: h.issuer.jwksUrl.toString(),
		AUTH_ISSUER: h.issuer.issuer,
		AUTH_AUDIENCE: h.issuer.audience,
		APISIX_BASE_URL: h.apisix.baseUrl,
		APISIX_CONSUMER_KEY: h.apisix.consumerKey,
		CONTRACTS_REFRESH_MS: '0',
		LOG_LEVEL: 'info',
		...ENV
	});
	const db = makeDb(config.databaseUrl);
	const logStream = new PassThrough();
	const chunks: string[] = [];
	logStream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
	const app = await buildApp({ config, db, logStream });
	await app.ready();
	const worker = startTurnWorker({ db, agent: app.agent, log: app.log, pollIntervalMs: 100 });
	return {
		app,
		client: makeClient({ app, issuer: h.issuer } as Parameters<typeof makeClient>[0]),
		logLines: () =>
			chunks
				.join('')
				.split('\n')
				.filter((l) => l.length > 0)
				.map((l) => JSON.parse(l) as Record<string, unknown>),
		worker,
		stop: async () => {
			await worker.stop();
			await app.close();
			await db.close();
		}
	};
}

async function seedAssistantRoom(h: TestHarness, owner: string, roomId: string): Promise<void> {
	const userId = `@twake-space-assistant-${owner}:test.local`;
	await withPrincipal(h.db, { id: owner }, async (tx) => {
		await tx.sql`insert into principals (id, actions) values (${owner}, ${PRINCIPAL_ACTIONS}::jsonb) on conflict do nothing`;
		await saveAssistant(tx, {
			owner,
			userId,
			name: 'A',
			deviceId: 'DEVICE',
			accessToken: 'token',
			roomId
		});
	});
	await h.db
		.sql`insert into assistant_rooms (room_id, owner, user_id) values (${roomId}, ${owner}, ${userId})`;
}

// Room turns carry their room in the log; the HTTP turns of the other tests do not
function roomTurnsStarted(lines: Record<string, unknown>[]): number {
	return lines.filter((l) => l['msg'] === 'turn started' && typeof l['roomId'] === 'string').length;
}

async function sendJobs(h: TestHarness): Promise<{ roomId: string; text: string }[]> {
	const rows = await h.db.sql<
		{ payload: unknown }[]
	>`select payload from jobs where kind = 'send' order by id`;
	return rows.map((r) => {
		const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as {
			roomId: string;
			text: string;
		};
		return { roomId: p.roomId, text: p.text };
	});
}

describe('two api replicas on one database', () => {
	let h: TestHarness;
	let a: TestClient;
	let b: Replica;
	let workerA: ReturnType<typeof startTurnWorker>;
	beforeAll(async () => {
		h = await startTestHarness({ env: ENV });
		a = makeClient(h);
		workerA = startTurnWorker({
			db: h.db,
			agent: h.app.agent,
			log: h.app.log,
			pollIntervalMs: 100
		});
		b = await startReplica(h);
		h.apisix.llm.script = (request: ChatRequest) => ({
			content: `echo: ${request.messages.at(-1)?.content ?? ''}`,
			delayMs: 150
		});
	});
	afterAll(async () => {
		await workerA.stop();
		await b.stop();
		await h.close();
	});

	it('continues on one replica a conversation started on the other', async () => {
		const first = await a.post<{ session_id: string }>('alice', '/v1/chat', {
			message: 'remember MARK_77'
		});
		h.apisix.llm.script = (request: ChatRequest) => {
			const text = request.messages.map((m) => m.content ?? '').join('\n');
			return { content: /MARK_\d+/.exec(text)?.[0] ?? 'nothing', delayMs: 50 };
		};
		const second = await b.client.post<{ answer: string }>('alice', '/v1/chat', {
			session_id: first.body.session_id,
			message: 'what was it?'
		});
		expect(second.status).toBe(200);
		expect(second.body.answer).toBe('MARK_77');
		const seenByB = await b.client.get<{ sessions: string[] }>('alice', '/v1/sessions');
		expect(seenByB.body.sessions).toContain(first.body.session_id);
		expect(
			(await b.client.get<{ sessions: string[] }>('bob', '/v1/sessions')).body.sessions
		).toEqual([]);
	});

	it('counts the turns per minute of a user across replicas', async () => {
		h.apisix.llm.script = () => ({ content: 'ok' });
		const clients = [a, b.client];
		for (let i = 0; i < 6; i += 1) {
			const reply = await clients[i % 2]?.post('hasty', '/v1/chat', { message: `m${i}` });
			expect(reply?.status).toBe(200);
		}
		const refusedOnA = await a.post<{ reason: string }>('hasty', '/v1/chat', { message: 'm6' });
		expect(refusedOnA.status).toBe(429);
		expect(refusedOnA.body.reason).toBe('user_rate');
		const refusedOnB = await b.client.post<{ reason: string }>('hasty', '/v1/chat', {
			message: 'm7'
		});
		expect(refusedOnB.status).toBe(429);
		expect((await b.client.post('calm', '/v1/chat', { message: 'fine' })).status).toBe(200);
	});

	it('shares the queue: every turn runs once, in order per owner, and a redelivery makes one turn', async () => {
		h.apisix.llm.script = (request: ChatRequest) => ({
			content: `echo: ${request.messages.at(-1)?.content ?? ''}`,
			delayMs: 150
		});
		const owners = ['o1', 'o2', 'o3', 'o4'];
		for (const owner of owners) await seedAssistantRoom(h, owner, `!room-${owner}:test.local`);
		const jobs: { owner: string; text: string; eventId: string }[] = [];
		for (const owner of owners) {
			for (let i = 1; i <= 3; i += 1)
				jobs.push({ owner, text: `${owner} message ${i}`, eventId: `$${owner}-${i}` });
		}
		for (const job of jobs) {
			const payload = {
				owner: job.owner,
				roomId: `!room-${job.owner}:test.local`,
				eventId: job.eventId,
				text: job.text
			};
			await enqueueJob(h.db, {
				kind: 'turn',
				payload,
				dedupKey: `turn:${job.eventId}`,
				groupKey: `turn:${job.owner}`
			});
		}
		// The same event delivered again changes nothing
		expect(await enqueueJob(h.db, { kind: 'turn', payload: {}, dedupKey: 'turn:$o1-1' })).toBe(
			false
		);
		for (let i = 0; i < 200; i += 1) {
			const remaining = await h.db.sql<
				{ n: number }[]
			>`select count(*)::int as n from jobs where kind = 'turn'`;
			if ((remaining[0]?.n ?? 1) === 0) break;
			await sleep(100);
		}
		const sent = await sendJobs(h);
		expect(sent).toHaveLength(12);
		for (const owner of owners) {
			const texts = sent.filter((s) => s.roomId === `!room-${owner}:test.local`).map((s) => s.text);
			expect(texts).toEqual([
				`echo: ${owner} message 1`,
				`echo: ${owner} message 2`,
				`echo: ${owner} message 3`
			]);
		}
		const startedOnA = roomTurnsStarted(h.logLines());
		const startedOnB = roomTurnsStarted(b.logLines());
		expect(startedOnA + startedOnB).toBe(12);
		expect(startedOnA).toBeGreaterThan(0);
		expect(startedOnB).toBeGreaterThan(0);
	});

	it('loses no queued turn when every replica restarts', async () => {
		await workerA.stop();
		await b.worker.stop();
		await h.db.sql`delete from jobs`;
		const payload = {
			owner: 'o1',
			roomId: '!room-o1:test.local',
			eventId: '$o1-after',
			text: 'after restart'
		};
		await enqueueJob(h.db, {
			kind: 'turn',
			payload,
			dedupKey: 'turn:$o1-after',
			groupKey: 'turn:o1'
		});
		const again = startTurnWorker({
			db: h.db,
			agent: h.app.agent,
			log: h.app.log,
			pollIntervalMs: 100
		});
		for (let i = 0; i < 100; i += 1) {
			if ((await sendJobs(h)).some((s) => s.text === 'echo: after restart')) break;
			await sleep(100);
		}
		expect((await sendJobs(h)).some((s) => s.text === 'echo: after restart')).toBe(true);
		await again.stop();
		workerA = startTurnWorker({
			db: h.db,
			agent: h.app.agent,
			log: h.app.log,
			pollIntervalMs: 100
		});
	});
});
