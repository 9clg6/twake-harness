import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient, type TestClient } from './helpers/client.js';

interface MemoryView {
	memory: string[];
	user: string[];
}

describe('memory stores owned by their user', () => {
	let h: TestHarness;
	let c: TestClient;
	beforeAll(async () => {
		h = await startTestHarness();
		c = makeClient(h);
	});
	afterAll(async () => {
		await h.close();
	});

	it('starts empty and holds what its owner adds, in both stores', async () => {
		expect((await c.get<MemoryView>('romain', '/v1/memory')).body).toEqual({
			memory: [],
			user: []
		});
		const note = await c.tool('romain', 'memory', {
			action: 'add',
			target: 'memory',
			content: 'Prefers short answers'
		});
		expect(note.status).toBe(200);
		expect(note.body['success']).toBe(true);
		await c.tool('romain', 'memory', {
			action: 'add',
			target: 'user',
			content: 'Works at LINAGORA'
		});
		expect((await c.get<MemoryView>('romain', '/v1/memory')).body).toEqual({
			memory: ['Prefers short answers'],
			user: ['Works at LINAGORA']
		});
	});

	it('replaces and removes an entry by its text', async () => {
		await c.tool('quentin', 'memory', { action: 'add', content: 'REPLACE_TEST' });
		const replaced = await c.tool('quentin', 'memory', {
			action: 'replace',
			old_text: 'REPLACE_TEST',
			content: 'REPLACED_TEST'
		});
		expect(replaced.body['success']).toBe(true);
		expect((await c.get<MemoryView>('quentin', '/v1/memory')).body.memory).toEqual([
			'REPLACED_TEST'
		]);
		const removed = await c.tool('quentin', 'memory', {
			action: 'remove',
			old_text: 'REPLACED_TEST'
		});
		expect(removed.body['success']).toBe(true);
		expect((await c.get<MemoryView>('quentin', '/v1/memory')).body.memory).toEqual([]);
	});

	it('never shows one user the memory of another', async () => {
		const view = await c.get<MemoryView>('quentin', '/v1/memory');
		expect(JSON.stringify(view.body)).not.toContain('Prefers short answers');
		expect((await c.get('quentin', '/v1/memory/romain')).status).toBe(404);
	});

	it('refuses an owner, a path or a target in the arguments', async () => {
		expect(
			(await c.tool('quentin', 'memory', { action: 'add', content: 'x', user_id: 'romain' })).status
		).toBe(404);
		expect(
			(await c.tool('quentin', 'memory', { action: 'add', content: 'x', path: '/data/romain' }))
				.status
		).toBe(404);
		expect(
			(await c.tool('quentin', 'memory', { action: 'add', content: 'x', target: '../romain' }))
				.status
		).toBe(404);
		expect((await c.get<MemoryView>('romain', '/v1/memory')).body.memory).toEqual([
			'Prefers short answers'
		]);
	});

	it('keeps every concurrent write of two users apart and loses none', async () => {
		const jobs: Promise<unknown>[] = [];
		for (const sub of ['romain', 'quentin']) {
			for (let i = 0; i < 20; i += 1) {
				jobs.push(c.tool(sub, 'memory', { action: 'add', content: `CONCURRENT_${sub}_${i}` }));
			}
		}
		const results = (await Promise.all(jobs)) as { body: { success?: boolean } }[];
		expect(results.every((r) => r.body.success === true)).toBe(true);
		for (const sub of ['romain', 'quentin']) {
			const other = sub === 'romain' ? 'quentin' : 'romain';
			const view = (await c.get<MemoryView>(sub, '/v1/memory')).body;
			for (let i = 0; i < 20; i += 1) expect(view.memory).toContain(`CONCURRENT_${sub}_${i}`);
			expect(JSON.stringify(view)).not.toContain(`CONCURRENT_${other}_`);
		}
	});

	it('refuses an entry beyond the store budget', async () => {
		const huge = await c.tool('romain', 'memory', { action: 'add', content: 'x'.repeat(3000) });
		expect(huge.status).toBe(200);
		expect(huge.body['success']).toBe(false);
	});

	it('refuses a write when the write right is revoked, and a read when the read right is', async () => {
		await h.db.sql.begin(async (sql) => {
			await sql`select set_config('app.principal', 'quentin', true)`;
			await sql`update principals set actions = '["chat","memory.read_own"]'::jsonb where id = 'quentin'`;
		});
		expect((await c.tool('quentin', 'memory', { action: 'add', content: 'late' })).status).toBe(
			403
		);
		expect((await c.get('quentin', '/v1/memory')).status).toBe(200);
		await h.db.sql.begin(async (sql) => {
			await sql`select set_config('app.principal', 'quentin', true)`;
			await sql`update principals set actions = '["chat"]'::jsonb where id = 'quentin'`;
		});
		expect((await c.get('quentin', '/v1/memory')).status).toBe(403);
	});

	it('survives a restart of the service on the same database', async () => {
		await h.close();
		h = await startTestHarness({ keepData: true });
		c = makeClient(h);
		const view = (await c.get<MemoryView>('romain', '/v1/memory')).body;
		expect(view.memory).toContain('Prefers short answers');
		expect(view.memory).toContain('CONCURRENT_romain_19');
		expect(view.user).toEqual(['Works at LINAGORA']);
		expect(JSON.stringify(view)).not.toContain('CONCURRENT_quentin_');
	});
});

describe('memory in the conversation', () => {
	let h: TestHarness;
	let c: TestClient;
	beforeAll(async () => {
		h = await startTestHarness();
		c = makeClient(h);
	});
	afterAll(async () => {
		await h.close();
	});

	it('injects the owner memory into a fresh conversation, and nothing of anyone else', async () => {
		await c.tool('romain', 'memory', { action: 'add', content: 'PRIVATE_ROMAIN_42' });
		await c.tool('quentin', 'memory', { action: 'add', content: 'PRIVATE_QUENTIN_77' });
		h.apisix.llm.script = (request) => {
			const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
			const found = /PRIVATE_[A-Z]+_\d+/g;
			return { content: (system.match(found) ?? ['none']).join(',') };
		};
		const romain = await c.post<{ answer: string }>('romain', '/v1/chat', {
			message: 'what do you know?'
		});
		expect(romain.body.answer).toBe('PRIVATE_ROMAIN_42');
		const quentin = await c.post<{ answer: string }>('quentin', '/v1/chat', {
			message: 'what do you know?'
		});
		expect(quentin.body.answer).toBe('PRIVATE_QUENTIN_77');
	});

	it('lets the model write a memory that a later session recalls, hidden from others', async () => {
		h.apisix.llm.calls.length = 0;
		h.apisix.llm.script = (_request, index) =>
			index === 0
				? {
						toolCalls: [
							{
								id: 'm1',
								type: 'function',
								function: {
									name: 'memory',
									arguments: JSON.stringify({
										action: 'add',
										target: 'memory',
										content: 'LLM_SAVED_1'
									})
								}
							}
						]
					}
				: { content: 'saved' };
		const first = await c.post<{ session_id: string; answer: string }>('romain', '/v1/chat', {
			message: 'save it'
		});
		expect(first.body.answer).toBe('saved');
		expect((await c.get<MemoryView>('romain', '/v1/memory')).body.memory).toContain('LLM_SAVED_1');
		const transcript = await c.get<{ messages: { role: string; content: string }[] }>(
			'romain',
			`/v1/sessions/${first.body.session_id}`
		);
		expect(
			transcript.body.messages.some(
				(m) => m.role === 'tool' && m.content.includes('"success":true')
			)
		).toBe(true);
		expect((await c.get<MemoryView>('quentin', '/v1/memory')).body.memory).not.toContain(
			'LLM_SAVED_1'
		);
	});

	it('nudges the model to memorize after a number of turns', async () => {
		h.apisix.llm.script = (request) => ({
			content: (request.messages[0]?.content ?? '').includes('worth remembering')
				? 'nudged'
				: 'quiet'
		});
		let answer = '';
		let session: string | undefined;
		for (let i = 0; i < 10; i += 1) {
			const res = await c.post<{ session_id: string; answer: string }>('nudge', '/v1/chat', {
				message: `turn ${i}`,
				...(session === undefined ? {} : { session_id: session })
			});
			session = res.body.session_id;
			answer = res.body.answer;
		}
		expect(answer).toBe('nudged');
	});
});
