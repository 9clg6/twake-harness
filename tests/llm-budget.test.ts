import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MAX_RETRY_TOKENS } from '../src/agent/turn.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { echoScript, type LlmScript } from './helpers/fake-apisix.js';

interface ChatReply {
	readonly answer?: string;
	readonly error?: string;
}

async function chat(
	h: TestHarness,
	sub: string,
	message: string,
	requestId: string
): Promise<{ status: number; body: ChatReply }> {
	const res = await h.app.inject({
		method: 'POST',
		url: '/v1/chat',
		headers: {
			authorization: `Bearer ${await h.issuer.mint({ sub })}`,
			'x-request-id': requestId
		},
		payload: { message }
	});
	return { status: res.statusCode, body: res.json() };
}

// A reasoning model that spends its whole budget deliberating stops with finish_reason length and
// writes nothing visible; on dev, qwen3.8 did so at the old 1024-token default
const THINKS_TOO_LONG = { content: null, reasoning: 'thinking it over', finishReason: 'length' };

describe('the token budget of a model call', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness();
	});
	afterAll(async () => {
		await h.close();
	});
	beforeEach(() => {
		h.apisix.llm.calls.length = 0;
		h.apisix.llm.script = echoScript;
	});

	it('is 8192 tokens when LLM_MAX_TOKENS is unset', async () => {
		const { status } = await chat(h, 'alice', 'Bonjour', 'budget-default');
		expect(status).toBe(200);
		expect(h.apisix.llm.calls[0]?.request.max_tokens).toBe(8192);
	});

	it('is doubled once when the model ran out while thinking, and the owner gets the answer', async () => {
		h.apisix.llm.script = (_request, callIndex) =>
			callIndex === 0 ? THINKS_TOO_LONG : { content: 'Nous sommes mardi.' };
		const { status, body } = await chat(h, 'alice', 'Quel jour sommes-nous ?', 'budget-retry');
		expect(status).toBe(200);
		expect(body.answer).toBe('Nous sommes mardi.');
		const [first, second] = h.apisix.llm.calls;
		expect(h.apisix.llm.calls).toHaveLength(2);
		expect(second?.request.max_tokens).toBe(2 * (first?.request.max_tokens ?? 0));
		expect(second?.request.messages).toEqual(first?.request.messages);
		const retry = h
			.logLines()
			.find(
				(line) => line['reqId'] === 'budget-retry' && line['msg'] === 'model ran out of budget'
			);
		expect(retry).toMatchObject({
			level: 30,
			iteration: 0,
			budget: 8192,
			retryBudget: 16384,
			usage: { completionTokens: 8192 }
		});
		expect(JSON.stringify(retry)).not.toContain('thinking it over');
	});

	it('is doubled as well when the reasoning came inline in think tags', async () => {
		h.apisix.llm.script = (_request, callIndex) =>
			callIndex === 0
				? { content: '<think>still weighing the options</think>', finishReason: 'length' }
				: { content: 'Il est 14 h 11.' };
		const { status, body } = await chat(h, 'alice', 'Quelle heure est-il ?', 'budget-think');
		expect(status).toBe(200);
		expect(body.answer).toBe('Il est 14 h 11.');
		expect(h.apisix.llm.calls).toHaveLength(2);
	});

	it('fails the turn as before when the retry ends empty too, after exactly two calls', async () => {
		h.apisix.llm.script = () => THINKS_TOO_LONG;
		const { status, body } = await chat(h, 'alice', 'Quel jour ?', 'budget-empty');
		expect(status).toBe(502);
		expect(body.error).toBe('execution failed');
		expect(h.apisix.llm.calls).toHaveLength(2);
	});

	it('keeps an answer the budget cut short instead of retrying', async () => {
		h.apisix.llm.script = () => ({ content: 'Une réponse tronquée', finishReason: 'length' });
		const { status, body } = await chat(h, 'alice', 'Raconte', 'budget-cut');
		expect(status).toBe(200);
		expect(body.answer).toBe('Une réponse tronquée');
		expect(h.apisix.llm.calls).toHaveLength(1);
	});
});

describe('a deployment that sets its own token budget', () => {
	let h: TestHarness;
	afterAll(async () => {
		await h.close();
	});

	it('caps the retry at the ceiling', async () => {
		h = await startTestHarness({ env: { LLM_MAX_TOKENS: '20000' } });
		const script: LlmScript = (_request, callIndex) =>
			callIndex === 0 ? THINKS_TOO_LONG : { content: 'ok' };
		h.apisix.llm.script = script;
		const { status } = await chat(h, 'alice', 'Bonjour', 'budget-cap');
		expect(status).toBe(200);
		expect(h.apisix.llm.calls.map((call) => call.request.max_tokens)).toEqual([
			20000,
			MAX_RETRY_TOKENS
		]);
	});
});

describe('a deployment already at the ceiling', () => {
	let h: TestHarness;
	afterAll(async () => {
		await h.close();
	});

	it('does not retry a call that could only end the same way', async () => {
		h = await startTestHarness({ env: { LLM_MAX_TOKENS: String(MAX_RETRY_TOKENS) } });
		h.apisix.llm.script = () => THINKS_TOO_LONG;
		const { status } = await chat(h, 'alice', 'Bonjour', 'budget-ceiling');
		expect(status).toBe(502);
		expect(h.apisix.llm.calls).toHaveLength(1);
	});
});
