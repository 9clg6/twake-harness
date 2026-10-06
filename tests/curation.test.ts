import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCuration } from '../src/curation/curation.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient, type TestClient } from './helpers/client.js';
import type { ChatRequest } from './helpers/fake-apisix.js';

describe('session search and daily curation', () => {
	let h: TestHarness;
	let c: TestClient;
	beforeAll(async () => {
		h = await startTestHarness();
		c = makeClient(h);
		h.apisix.llm.script = (request: ChatRequest) => ({
			content: `echo: ${request.messages.at(-1)?.content ?? ''}`
		});
	});
	afterAll(async () => {
		await h.close();
	});

	it("finds a past conversation by its words, and never another user's", async () => {
		await c.post('romain', '/v1/chat', { message: 'The budget meeting is on Thursday' });
		await c.post('quentin', '/v1/chat', { message: 'The budget of quentin is secret' });
		const found = await c.tool<{ sessions: { session_id: string; snippet: string }[] }>(
			'romain',
			'session_search',
			{ query: 'budget' }
		);
		expect(found.status).toBe(200);
		expect(found.body.sessions).toHaveLength(1);
		expect(found.body.sessions[0]?.snippet).toContain('Thursday');
		h.apisix.llm.calls.length = 0;
		h.apisix.llm.script = (request: ChatRequest, index: number) =>
			index === 0
				? {
						toolCalls: [
							{
								id: 's',
								type: 'function',
								function: { name: 'session_search', arguments: JSON.stringify({ query: 'budget' }) }
							}
						]
					}
				: { content: `found: ${request.messages.find((m) => m.role === 'tool')?.content ?? ''}` };
		const res = await c.post<{ answer: string }>('romain', '/v1/chat', {
			message: 'when is the budget meeting?'
		});
		expect(res.body.answer).toContain('Thursday');
		expect(res.body.answer).not.toContain('secret');
	});

	it('merges duplicate memory entries and turns a recurring request into a proposal', async () => {
		h.apisix.llm.script = (request: ChatRequest) => ({
			content: `echo: ${request.messages.at(-1)?.content ?? ''}`
		});
		await c.tool('romain', 'memory', { action: 'add', content: 'Prefers tea' });
		await c.tool('romain', 'memory', { action: 'add', content: ' prefers  TEA ' });
		await c.tool('romain', 'memory', { action: 'add', content: 'Prefers coffee' });
		for (let i = 0; i < 3; i += 1) {
			await c.post('romain', '/v1/chat', { message: 'Summarize my week in three points' });
		}
		await c.post('quentin', '/v1/chat', { message: 'Summarize my week in three points' });
		const report = await runCuration(h.db, h.app.log);
		expect(report.owners).toBeGreaterThanOrEqual(2);
		expect(report.duplicatesRemoved).toBe(1);
		expect(report.proposalsMade).toBe(1);
		const memory = await c.get<{ memory: string[] }>('romain', '/v1/memory');
		expect(memory.body.memory).toEqual(['Prefers tea', 'Prefers coffee']);
		const proposals = await c.get<{ proposals: { id: string; description: string }[] }>(
			'romain',
			'/v1/skills/proposals'
		);
		expect(proposals.body.proposals).toHaveLength(1);
		expect(proposals.body.proposals[0]?.description).toContain('3 conversations');
		expect(
			(await c.get<{ proposals: unknown[] }>('quentin', '/v1/skills/proposals')).body.proposals
		).toEqual([]);
		const again = await runCuration(h.db, h.app.log);
		expect(again.duplicatesRemoved).toBe(0);
		expect(again.proposalsMade).toBe(0);
		expect(h.logLines().filter((line) => line['msg'] === 'curation run')).toHaveLength(2);
	});
});
