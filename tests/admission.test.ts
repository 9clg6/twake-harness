import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient, type TestClient } from './helpers/client.js';
import type { ChatRequest } from './helpers/fake-apisix.js';

describe('admission: nobody saturates the replica', () => {
	let h: TestHarness;
	let c: TestClient;
	beforeAll(async () => {
		h = await startTestHarness({
			env: {
				ADMISSION_MAX_INFLIGHT: '4',
				ADMISSION_USER_QUEUE: '2',
				ADMISSION_USER_PER_MINUTE: '12',
				ADMISSION_USER_DAILY_TOKENS: '200000',
				ADMISSION_GLOBAL_PER_MINUTE: '1000'
			}
		});
		// The queue, the turns in flight and the metrics are this replica's: one replica is observed
		c = makeClient({ app: h.app, apps: [h.app], issuer: h.issuer });
	});
	afterAll(async () => {
		await h.close();
	});

	it('throttles a flooding user while a normal user keeps a short latency', async () => {
		h.apisix.llm.script = (request: ChatRequest) => ({
			content: `echo: ${request.messages.at(-1)?.content ?? ''}`,
			delayMs: 400
		});
		const flood = Array.from({ length: 8 }, (_, i) =>
			c.post<{ error?: string; reason?: string }>('flooder', '/v1/chat', { message: `flood ${i}` })
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const started = Date.now();
		const normal = await c.post<{ answer: string }>('normal', '/v1/chat', { message: 'hello' });
		const latency = Date.now() - started;
		const results = await Promise.all(flood);
		expect(normal.status).toBe(200);
		expect(normal.body.answer).toBe('echo: hello');
		expect(latency).toBeLessThan(1500);
		const refused = results.filter((r) => r.status === 429);
		const served = results.filter((r) => r.status === 200);
		expect(served.length).toBe(3);
		expect(refused.length).toBe(5);
		expect(refused.every((r) => r.body.reason === 'user_queue_full')).toBe(true);
		expect(
			h
				.logLines()
				.some((line) => line['msg'] === 'admission refused' && line['reason'] === 'user_queue_full')
		).toBe(true);
	});

	it('refuses a user beyond their turns per minute', async () => {
		h.apisix.llm.script = () => ({ content: 'ok' });
		const results: number[] = [];
		for (let i = 0; i < 13; i += 1) {
			results.push((await c.post('hasty', '/v1/chat', { message: `m${i}` })).status);
		}
		expect(results.slice(0, 12).every((s) => s === 200)).toBe(true);
		expect(results[12]).toBe(429);
		expect((await c.post('calm', '/v1/chat', { message: 'still fine' })).status).toBe(200);
	});

	it('refuses a user who spent their daily token budget, and only them', async () => {
		h.apisix.llm.script = () => ({ content: 'ok' });
		await h.db.sql.begin(async (sql) => {
			await sql`select set_config('app.principal', 'spender', true)`;
			await sql`insert into usage_daily (owner, day, tokens) values ('spender', current_date, 199990)`;
		});
		expect((await c.post('spender', '/v1/chat', { message: 'one more' })).status).toBe(200);
		const refused = await c.post<{ reason: string }>('spender', '/v1/chat', {
			message: 'and another'
		});
		expect(refused.status).toBe(429);
		expect(refused.body.reason).toBe('user_budget');
		expect((await c.post('thrifty', '/v1/chat', { message: 'fine' })).status).toBe(200);
	});

	it('queues different users when the replica is full and serves them all', async () => {
		h.apisix.llm.script = (request: ChatRequest) => ({
			content: `echo: ${request.messages.at(-1)?.content ?? ''}`,
			delayMs: 300
		});
		const users = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
		const results = await Promise.all(
			users.map((u) => c.post<{ answer: string }>(u, '/v1/chat', { message: u }))
		);
		expect(results.every((r) => r.status === 200)).toBe(true);
		expect(h.logLines().some((line) => line['msg'] === 'admission queued')).toBe(true);
	});

	it('exposes turns in progress, queued and refused, and the assistants held', async () => {
		const res = await h.app.inject({ method: 'GET', url: '/metrics' });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('harness_turns_inflight 0');
		expect(res.body).toContain('harness_turns_refused_total{reason="user_queue_full"} 5');
		expect(res.body).toContain('harness_turns_refused_total{reason="user_budget"} 1');
		expect(res.body).toContain('harness_assistants_held 0');
	});
});
