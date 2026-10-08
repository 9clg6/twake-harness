import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MAX_RETRY_TOKENS } from '../src/agent/turn.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import {
	A_HUNDRED_THOUSAND_TOKENS,
	echoScript,
	pastTheLimit,
	readCall,
	type LlmScript
} from './helpers/fake-apisix.js';

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

describe('the token budget of a turn', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness();
	});
	afterAll(async () => {
		await h.close();
	});
	beforeEach(() => {
		h.apisix.llm.calls.length = 0;
	});

	// Each test is the first turn of its owner: past the tokens of a day, which admission checks
	// before a turn starts, their next turn would be refused

	it('is 250000 tokens when TURN_MAX_TOKENS is unset; past them, a last call without tools ends the turn', async () => {
		// Each answer reads once and reports 100,000 tokens: after the third, the turn is past its
		// limit, and asked without tools, the model tells where things stand
		const progress = 'I read your consents three times; more reads remain. Ask me to continue.';
		h.apisix.llm.script = pastTheLimit({ content: progress }, A_HUNDRED_THOUSAND_TOKENS);
		const { status, body } = await chat(h, 'erin', 'Read them all', 'turn-tokens');
		expect(status).toBe(200);
		expect(body.answer).toBe(progress);
		expect(h.apisix.llm.calls).toHaveLength(4);
		expect(h.apisix.llm.calls.slice(0, 3).every((c) => (c.request.tools ?? []).length > 0)).toBe(
			true
		);
		const last = h.apisix.llm.calls[3]?.request;
		expect(last?.tools).toBeUndefined();
		// The model is told, in its system prompt, what to answer: what it did, what remains, and that
		// the owner can ask it to continue
		const instruction = last?.messages[0];
		expect(instruction?.role).toBe('system');
		expect(instruction?.content).toMatch(/limit of 250000 tokens/);
		expect(instruction?.content).toMatch(/what you did, what remains/);
		expect(instruction?.content).toMatch(/ask you to continue/);
		// Every read the model asked for ran
		const results = (last?.messages ?? [])
			.filter((m) => m.role === 'tool')
			.map((m) => JSON.parse(m.content ?? '{}') as unknown);
		expect(results).toHaveLength(3);
		for (const result of results) expect(result).toHaveProperty('consents');
		const lines = h.logLines().filter((line) => line['reqId'] === 'turn-tokens');
		expect(lines.find((line) => line['msg'] === 'token limit reached')).toMatchObject({
			level: 30,
			limit: 250_000,
			tokens: 300_000
		});
		expect(lines.some((line) => line['msg'] === 'tool call limit reached')).toBe(false);
	});

	it('leaves a turn under them as it was, down to the answer that takes it past them', async () => {
		// Two answers read once each, at 100,000 tokens: the turn is under its limit when it asks for
		// the third, which answers, and takes it past
		h.apisix.llm.script = (_request, index) =>
			index < 2
				? { toolCalls: [readCall(index)], usage: A_HUNDRED_THOUSAND_TOKENS }
				: { content: 'All read.', usage: A_HUNDRED_THOUSAND_TOKENS };
		const { status, body } = await chat(h, 'frank', 'Read them all', 'turn-under');
		expect(status).toBe(200);
		expect(body.answer).toBe('All read.');
		expect(h.apisix.llm.calls).toHaveLength(3);
		expect(h.apisix.llm.calls.every((c) => (c.request.tools ?? []).length > 0)).toBe(true);
		const lines = h.logLines().filter((line) => line['reqId'] === 'turn-under');
		expect(lines.some((line) => line['msg'] === 'token limit reached')).toBe(false);
		// The prompts and answers of all its calls add up
		expect(lines.find((line) => line['msg'] === 'turn finished')).toMatchObject({
			tokens: 300_000
		});
	});

	it('makes no call with tools past them, not even the retry of an answer that ran out while thinking', async () => {
		// Two answers read at 100,000 tokens each; the third runs out while thinking at 100,000 more,
		// which takes the turn past its limit: asked again, with its tools, it would read once more
		const progress =
			'I read your consents twice, then ran out of room to think. Ask me to continue.';
		h.apisix.llm.script = (request, index) =>
			request.tools === undefined
				? { content: progress }
				: index === 2
					? { ...THINKS_TOO_LONG, usage: A_HUNDRED_THOUSAND_TOKENS }
					: { toolCalls: [readCall(index)], usage: A_HUNDRED_THOUSAND_TOKENS };
		const { status, body } = await chat(h, 'gina', 'Read them all', 'turn-tokens-retry');
		expect(status).toBe(200);
		expect(body.answer).toBe(progress);
		// The answer that ran out is not asked for again: the next call is the last, without tools
		expect(h.apisix.llm.calls.map((c) => c.request.tools !== undefined)).toEqual([
			true,
			true,
			true,
			false
		]);
		const lines = h.logLines().filter((line) => line['reqId'] === 'turn-tokens-retry');
		expect(lines.find((line) => line['msg'] === 'token limit reached')).toMatchObject({
			level: 30,
			limit: 250_000,
			tokens: 300_000
		});
	});

	it('ends on its last call, without tools, when the retry of an answer that ran out takes it past them', async () => {
		// A first answer reads at 100,000 tokens; the second runs out while thinking at 100,000 more,
		// under the limit, so it is asked again with its tools, and runs out once more at 100,000, which
		// takes the turn past its limit: rather than fail, the turn ends on its last call
		const progress =
			'I read your consents once, then ran out of room to think. Ask me to continue.';
		h.apisix.llm.script = (request, index) =>
			request.tools === undefined
				? { content: progress }
				: index === 0
					? { toolCalls: [readCall(0)], usage: A_HUNDRED_THOUSAND_TOKENS }
					: { ...THINKS_TOO_LONG, usage: A_HUNDRED_THOUSAND_TOKENS };
		const { status, body } = await chat(h, 'kate', 'Read them all', 'turn-tokens-retried');
		expect(status).toBe(200);
		expect(body.answer).toBe(progress);
		// The retry, with its tools at twice the budget, then the last call, without them
		expect(
			h.apisix.llm.calls.map((c) => [c.request.tools !== undefined, c.request.max_tokens])
		).toEqual([
			[true, 8192],
			[true, 8192],
			[true, 16384],
			[false, 8192]
		]);
		const lines = h.logLines().filter((line) => line['reqId'] === 'turn-tokens-retried');
		expect(lines.find((line) => line['msg'] === 'token limit reached')).toMatchObject({
			limit: 250_000,
			tokens: 300_000
		});
	});

	it('still doubles the budget of the last call, without tools, whose answer ran out while thinking', async () => {
		// Three reads at 100,000 tokens each take the turn past its limit; asked without tools, the
		// model runs out while thinking, and asked again with twice the budget, tells where things stand
		const progress = 'I read your consents three times; more reads remain. Ask me to continue.';
		const reads = pastTheLimit({ content: progress }, A_HUNDRED_THOUSAND_TOKENS);
		h.apisix.llm.script = (request, index) =>
			index === 3 ? THINKS_TOO_LONG : reads(request, index);
		const { status, body } = await chat(h, 'jack', 'Read them all', 'turn-tokens-last-retry');
		expect(status).toBe(200);
		expect(body.answer).toBe(progress);
		expect(
			h.apisix.llm.calls.map((c) => [c.request.tools !== undefined, c.request.max_tokens])
		).toEqual([
			[true, 8192],
			[true, 8192],
			[true, 8192],
			[false, 8192],
			[false, 16384]
		]);
	});

	it('logs them and what it spent when the answer that takes it past them goes past its tool calls too', async () => {
		// One answer makes seven reads and reports 300,000 tokens: six run, the seventh is past the six
		// tool calls of a message, and the turn is past its tokens
		const progress = 'I read your consents six times; one read remains. Ask me to continue.';
		h.apisix.llm.script = (request) =>
			request.tools === undefined
				? { content: progress }
				: {
						toolCalls: Array.from({ length: 7 }, (_, n) => readCall(n)),
						usage: { promptTokens: 295_000, completionTokens: 5_000 }
					};
		const { status, body } = await chat(h, 'hank', 'Read them all at once', 'turn-tokens-calls');
		expect(status).toBe(200);
		expect(body.answer).toBe(progress);
		const lines = h.logLines().filter((line) => line['reqId'] === 'turn-tokens-calls');
		expect(lines.find((line) => line['msg'] === 'tool call limit reached')).toMatchObject({
			limit: 6,
			notRun: 1
		});
		expect(lines.find((line) => line['msg'] === 'token limit reached')).toMatchObject({
			level: 30,
			limit: 250_000,
			tokens: 300_000
		});
		// The model is told of the read that did not run
		expect(h.apisix.llm.calls[1]?.request.messages[0]?.content).toMatch(/limit of 6 tool calls/);
	});

	it('counts nothing for the answers that report no usage, and warns of them once', async () => {
		// Neither of the two answers, a read then the answer, reports what it read and wrote: the turn
		// counts them as nothing, against its limit as against the owner's day
		h.apisix.llm.script = (_request, index) =>
			index === 0 ? { toolCalls: [readCall(0)], usage: null } : { content: 'Read.', usage: null };
		const { status, body } = await chat(h, 'ivy', 'Read them', 'turn-unreported');
		expect(status).toBe(200);
		expect(body.answer).toBe('Read.');
		expect(h.apisix.llm.calls).toHaveLength(2);
		const lines = h.logLines().filter((line) => line['reqId'] === 'turn-unreported');
		expect(lines.filter((line) => line['msg'] === 'model reported no usage')).toEqual([
			expect.objectContaining({ level: 40, iteration: 0 })
		]);
		expect(lines.find((line) => line['msg'] === 'turn finished')).toMatchObject({ tokens: 0 });
	});
});
