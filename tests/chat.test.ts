import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';
import {
	echoScript,
	pastTheLimit,
	type ChatRequest,
	type ScriptedReply,
	type ToolCall
} from './helpers/fake-apisix.js';

interface ChatReply {
	session_id: string;
	answer: string;
	model: string;
}

describe('a chat turn with the scripted model', () => {
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

	async function chat(
		sub: string,
		body: Record<string, unknown>,
		requestId?: string
	): Promise<{ status: number; body: ChatReply & { error?: string } }> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${await h.issuer.mint({ sub })}`
		};
		if (requestId !== undefined) headers['x-request-id'] = requestId;
		const res = await h.app.inject({ method: 'POST', url: '/v1/chat', headers, payload: body });
		return { status: res.statusCode, body: res.json() };
	}

	it('answers a new message and opens a session the caller owns', async () => {
		const { status, body } = await chat('alice', { message: 'Bonjour' });
		expect(status).toBe(200);
		expect(body.answer).toBe('echo: Bonjour');
		expect(body.model).toBe('qwen3.8');
		expect(body.session_id).toMatch(/^[0-9a-f]{32}$/);
		const call = h.apisix.llm.calls[0];
		expect(call?.apiKey).toBe(h.apisix.consumerKey);
		expect(call?.request.model).toBe('qwen3.8');
		expect(call?.request.messages[0]?.role).toBe('system');
		expect(call?.request.messages.at(-1)).toMatchObject({ role: 'user', content: 'Bonjour' });
	});

	it('continues a session with its history, so the model can recall an earlier value', async () => {
		const marker = `PRIVATE_${Date.now()}`;
		h.apisix.llm.script = (request: ChatRequest) => {
			const history = request.messages.map((m) => m.content ?? '').join('\n');
			const found = /PRIVATE_\d+/.exec(history);
			return { content: found === null ? 'nothing' : found[0] };
		};
		const first = await chat('alice', { message: `Remember ${marker}` });
		const second = await chat('alice', {
			session_id: first.body.session_id,
			message: 'What was the value?'
		});
		expect(second.status).toBe(200);
		expect(second.body.session_id).toBe(first.body.session_id);
		expect(second.body.answer).toBe(marker);
		const lastCall = h.apisix.llm.calls.at(-1);
		expect(lastCall?.request.messages.some((m) => m.content === `Remember ${marker}`)).toBe(true);
	});

	it('refuses a session that is not mine, or does not exist, before any model call', async () => {
		const own = await chat('alice', { message: 'hello' });
		h.apisix.llm.calls.length = 0;
		const foreign = await chat('bob', { session_id: own.body.session_id, message: 'hi' });
		expect(foreign.status).toBe(404);
		const missing = await chat('bob', { session_id: '0'.repeat(32), message: 'hi' });
		expect(missing.status).toBe(404);
		expect(missing.body).toEqual(foreign.body);
		expect(h.apisix.llm.calls).toHaveLength(0);
	});

	it('refuses a malformed body', async () => {
		const res = await chat('alice', { message: 'x', user_id: 'bob' });
		expect(res.status).toBe(400);
		expect((await chat('alice', {})).status).toBe(400);
	});

	it('keeps the reasoning out of the answer and out of the info logs', async () => {
		h.apisix.llm.script = () => ({
			reasoning: 'Let me think about alpha and beta.',
			content: '<think>hidden deliberation</think>The answer is 42.'
		});
		const { body } = await chat('alice', { message: 'question' }, 'turn-reasoning');
		expect(body.answer).toBe('The answer is 42.');
		expect(body.answer).not.toContain('think');
		const lines = h.logLines().filter((line) => line['reqId'] === 'turn-reasoning');
		const modelLine = lines.find((line) => line['msg'] === 'model answered');
		expect(modelLine?.['hasReasoning']).toBe(true);
		expect(modelLine?.['answerLength']).toBe('The answer is 42.'.length);
		const promptLine = lines.find((line) => line['msg'] === 'model asked');
		expect(promptLine?.['messageCount']).toBeGreaterThanOrEqual(2);
		expect(promptLine?.['messages']).toBeUndefined();
		const text = JSON.stringify(lines);
		expect(text).not.toContain('alpha and beta');
		expect(text).not.toContain('hidden deliberation');
	});

	it('runs a tool call from the model and logs its outcome, ending the turn on a clarification', async () => {
		h.apisix.llm.script = (_request, index) =>
			index === 0
				? {
						toolCalls: [
							{
								id: 'call_1',
								type: 'function',
								function: {
									name: 'clarify',
									arguments: JSON.stringify({ question: 'Which file?' })
								}
							}
						]
					}
				: { content: 'should not be reached' };
		const { body } = await chat('alice', { message: 'open it' }, 'turn-tool');
		expect(body.answer).toBe('Which file?');
		expect(h.apisix.llm.calls).toHaveLength(1);
		const toolLine = h
			.logLines()
			.find((line) => line['reqId'] === 'turn-tool' && line['msg'] === 'tool called');
		expect(toolLine?.['tool']).toBe('clarify');
		expect(toolLine?.['status']).toBe('final');
		expect(toolLine?.['arguments']).toBeUndefined();
	});

	it('ends a turn that reaches its limit of tool calls with what the model did and what remains', async () => {
		// Four calls at a time for as long as it has tools: its second answer goes past the six calls
		// one message may run, and asked without tools, it tells where it stands
		const progress = 'I read your consents six times; two reads remain. Ask me to continue.';
		h.apisix.llm.script = (request, index) =>
			request.tools === undefined
				? { content: progress }
				: {
						toolCalls: [0, 1, 2, 3].map((n) => ({
							id: `read_${index}_${n}`,
							type: 'function' as const,
							function: { name: 'consents_list', arguments: '{}' }
						}))
					};
		const { status, body } = await chat('alice', { message: 'Read them all' }, 'turn-limit');
		expect(status).toBe(200);
		expect(body.answer).toBe(progress);
		expect(h.apisix.llm.calls).toHaveLength(3);
		expect(h.apisix.llm.calls.slice(0, 2).every((c) => (c.request.tools ?? []).length > 0)).toBe(
			true
		);
		const last = h.apisix.llm.calls[2]?.request;
		expect(last?.tools).toBeUndefined();
		// The model is told, in its system prompt, what to answer: what it did, what remains, and that
		// the owner can ask it to continue
		const instruction = last?.messages[0];
		expect(instruction?.role).toBe('system');
		expect(instruction?.content).toMatch(/limit of 6 tool calls/);
		expect(instruction?.content).toMatch(/what you did, what remains/);
		expect(instruction?.content).toMatch(/ask you to continue/);
		// Six calls ran; each call past the limit reads that it did not run
		const results = (last?.messages ?? [])
			.filter((m) => m.role === 'tool')
			.map((m) => ({ id: m.tool_call_id, result: JSON.parse(m.content ?? '{}') as unknown }));
		expect(results.map((r) => r.id)).toEqual([
			'read_0_0',
			'read_0_1',
			'read_0_2',
			'read_0_3',
			'read_1_0',
			'read_1_1',
			'read_1_2',
			'read_1_3'
		]);
		for (const ran of results.slice(0, 6)) expect(ran.result).toHaveProperty('consents');
		for (const skipped of results.slice(6)) {
			expect(skipped.result).toMatchObject({ error: 'tool_call_limit' });
			expect(JSON.stringify(skipped.result)).toMatch(/limit of 6 tool calls/);
		}
		const reached = h
			.logLines()
			.find((line) => line['reqId'] === 'turn-limit' && line['msg'] === 'tool call limit reached');
		expect(reached).toMatchObject({ level: 30, limit: 6, toolCalls: 6, notRun: 2 });
		// The conversation keeps the calls and the answer, never the instruction of that last call
		h.apisix.llm.script = echoScript;
		await chat('alice', { session_id: body.session_id, message: 'Go on' });
		const next = h.apisix.llm.calls[3]?.request.messages ?? [];
		expect(next.filter((m) => m.role === 'tool')).toHaveLength(8);
		expect(next.at(-2)).toMatchObject({ role: 'assistant', content: progress });
		expect(next.some((m) => /ask you to continue/.test(m.content ?? ''))).toBe(false);
	});

	// The calls a held model received, in order of arrival, and the most it held at once
	interface HeldModelCalls {
		readonly entered: readonly string[];
		mostAtOnce(): number;
		release(index: number): void;
		releaseAll(): void;
	}

	// Holds every model call open until the test releases it: overlap and order are then
	// observed, not inferred from timings
	function holdModelCalls(): HeldModelCalls {
		const entered: string[] = [];
		const releases: (() => void)[] = [];
		let inside = 0;
		let most = 0;
		h.apisix.llm.script = (request) => {
			entered.push(String(request.messages.at(-1)?.content ?? ''));
			inside += 1;
			most = Math.max(most, inside);
			const released = new Promise<void>((resolve) => releases.push(resolve));
			return {
				content: 'ok',
				hold: released.then(() => {
					inside -= 1;
				})
			};
		};
		return {
			entered,
			mostAtOnce: () => most,
			release: (index) => releases[index]?.(),
			releaseAll: () => {
				for (const release of releases) release();
			}
		};
	}

	// Waits for a state the harness reaches by itself; the bound only turns a failure into an error
	async function waitUntil(what: string, check: () => boolean | Promise<boolean>): Promise<void> {
		for (let i = 0; i < 1000; i += 1) {
			if (await check()) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`${what} did not happen within 10 s`);
	}

	// The admission gauges of the replica the tests talk to, as the metrics endpoint exposes them
	async function admissionGauge(gauge: 'inflight' | 'queued'): Promise<number> {
		const res = await h.app.inject({ method: 'GET', url: '/metrics' });
		return Number(new RegExp(`^harness_turns_${gauge} (\\d+)$`, 'm').exec(res.body)?.[1]);
	}

	// Runs a scenario against a held model once the turns of earlier tests have ended, since one
	// left running would reach this model and skew its counts; nothing stays held afterwards
	async function withHeldModelCalls(
		scenario: (model: HeldModelCalls) => Promise<void>
	): Promise<void> {
		await waitUntil(
			'the turns of earlier tests ending',
			async () => (await admissionGauge('inflight')) === 0
		);
		const model = holdModelCalls();
		try {
			await scenario(model);
		} finally {
			model.releaseAll();
		}
	}

	it('serializes the turns of one user', async () => {
		await withHeldModelCalls(async (model) => {
			const turns = [chat('alice', { message: '1' }), chat('alice', { message: '2' })];
			await waitUntil('a first turn reaching the model', () => model.entered.length >= 1);
			// While that call is held, the user's other turn waits in admission and never reaches it
			await waitUntil(
				'the second turn waiting in admission',
				async () => (await admissionGauge('queued')) === 1
			);
			expect(model.entered).toHaveLength(1);
			model.release(0);
			await waitUntil('the second turn reaching the model', () => model.entered.length >= 2);
			model.release(1);
			const replies = await Promise.all(turns);
			expect(replies.map((r) => r.status)).toEqual([200, 200]);
			expect(model.mostAtOnce()).toBe(1);
		});
	});

	it('runs the turns of two users at the same time', async () => {
		await withHeldModelCalls(async (model) => {
			const turns = [
				chat('carol', { message: 'from carol' }),
				chat('dave', { message: 'from dave' })
			];
			// No call leaves the model before both are inside it, so the overlap is forced
			await waitUntil('both turns being inside the model', () => model.entered.length >= 2);
			expect([...model.entered].sort()).toEqual(['from carol', 'from dave']);
			expect(model.mostAtOnce()).toBe(2);
			model.releaseAll();
			const replies = await Promise.all(turns);
			expect(replies.map((r) => r.status)).toEqual([200, 200]);
		});
	});
});

async function chatIn(
	h: TestHarness,
	payload: Record<string, unknown>,
	requestId: string
): Promise<{ status: number; body: ChatReply & { error?: string } }> {
	const res = await h.app.inject({
		method: 'POST',
		url: '/v1/chat',
		headers: {
			authorization: `Bearer ${await h.issuer.mint({ sub: 'alice' })}`,
			'x-request-id': requestId
		},
		payload
	});
	return { status: res.statusCode, body: res.json() };
}

// A call the model makes, or writes as text, once it has no tools left
const LATE_CALL: ToolCall = {
	id: 'late',
	type: 'function',
	function: { name: 'consents_list', arguments: '{}' }
};
const LATE_CALL_MARKUP = '<tool_call>\n{"name": "consents_list", "arguments": {}}\n</tool_call>';

describe('the last answer of a turn past its limit of tool calls', () => {
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

	it("is the harness's own notice of what was done when the model gives no words", async () => {
		const notice =
			'I did 6 actions for your request, then reached my limit for this message. Say “continue” and I will carry on.';
		const wordless: Record<string, { readonly last: ScriptedReply; readonly reason: string }> = {
			calls: { last: { toolCalls: [LATE_CALL] }, reason: 'tool_calls' },
			nothing: { last: { content: '' }, reason: 'empty' },
			markup: { last: { content: LATE_CALL_MARKUP }, reason: 'markup' },
			json: { last: { content: '{"name": "consents_list", "arguments": {}}' }, reason: 'markup' },
			fenced: {
				last: {
					content:
						'```json\n[{"type": "function", "function": {"name": "consents_list", "arguments": "{}"}}]\n```'
				},
				reason: 'markup'
			}
		};
		let session = '';
		for (const [kind, { last, reason }] of Object.entries(wordless)) {
			h.apisix.llm.script = pastTheLimit(last);
			const { status, body } = await chatIn(h, { message: 'Read them all' }, `notice-${kind}`);
			expect({ kind, status, answer: body.answer }).toEqual({ kind, status: 200, answer: notice });
			const noticed = h
				.logLines()
				.find(
					(line) => line['reqId'] === `notice-${kind}` && line['msg'] === 'tool call limit notice'
				);
			expect(noticed).toMatchObject({ level: 30, actions: 6, reason });
			session = body.session_id;
		}
		// The conversation keeps the notice as the assistant's answer, for the model's next turn
		h.apisix.llm.script = echoScript;
		const calls = h.apisix.llm.calls.length;
		await chatIn(h, { session_id: session, message: 'continue' }, 'notice-next');
		const next = h.apisix.llm.calls[calls]?.request.messages ?? [];
		expect(next.at(-2)).toMatchObject({ role: 'assistant', content: notice });
	});

	it('keeps the words the model wrote beside its calls', async () => {
		const words = 'Six reads done, two remain. Ask me to continue.';
		for (const last of [
			{ content: words, toolCalls: [LATE_CALL] },
			{ content: `${words}\n${LATE_CALL_MARKUP}` }
		]) {
			h.apisix.llm.script = pastTheLimit(last);
			const { status, body } = await chatIn(h, { message: 'Read them all' }, 'notice-words');
			expect(status).toBe(200);
			expect(body.answer).toBe(words);
		}
	});
});

// What each answer of the model reports it read and wrote: the third takes a turn past 1000 tokens
const FOUR_HUNDRED_TOKENS = { promptTokens: 300, completionTokens: 100 };

describe('the last answer of a turn past its limit of tokens', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness({ env: { TURN_MAX_TOKENS: '1000' } });
	});
	afterAll(async () => {
		await h.close();
	});
	beforeEach(() => {
		h.apisix.llm.calls.length = 0;
	});

	it("is the harness's own notice of what was done when the model gives no words", async () => {
		const notice =
			'I did 3 actions for your request, then reached my limit for this message. Say “continue” and I will carry on.';
		h.apisix.llm.script = pastTheLimit({ content: LATE_CALL_MARKUP }, FOUR_HUNDRED_TOKENS);
		const { status, body } = await chatIn(h, { message: 'Read them all' }, 'tokens-notice');
		expect(status).toBe(200);
		expect(body.answer).toBe(notice);
		const lines = h.logLines().filter((line) => line['reqId'] === 'tokens-notice');
		expect(lines.find((line) => line['msg'] === 'token limit reached')).toMatchObject({
			level: 30,
			limit: 1000,
			tokens: 1200
		});
		expect(lines.find((line) => line['msg'] === 'token limit notice')).toMatchObject({
			level: 30,
			actions: 3,
			reason: 'markup'
		});
		// The conversation keeps the reads and the notice as the assistant's answer, for the model's
		// next turn, never the instruction of the call that ended this one
		h.apisix.llm.script = echoScript;
		await chatIn(h, { session_id: body.session_id, message: 'continue' }, 'tokens-next');
		const next = h.apisix.llm.calls[4]?.request.messages ?? [];
		expect(next.filter((m) => m.role === 'tool')).toHaveLength(3);
		expect(next.at(-2)).toMatchObject({ role: 'assistant', content: notice });
		expect(next.some((m) => /ask you to continue/.test(m.content ?? ''))).toBe(false);
	});
});

describe('the notice of a turn past its limit in a deployment that speaks French', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness({
			env: { ASSISTANT_LOCALE: 'fr', TURN_MAX_TOOL_CALLS: '1', TURN_MAX_TOKENS: '1000' }
		});
	});
	afterAll(async () => {
		await h.close();
	});

	it('speaks French, and of one action as one', async () => {
		h.apisix.llm.script = pastTheLimit({ content: LATE_CALL_MARKUP });
		const { status, body } = await chatIn(h, { message: 'Lis-les toutes' }, 'notice-fr');
		expect(status).toBe(200);
		expect(body.answer).toBe(
			"J'ai fait 1 action pour ta demande, puis j'ai atteint ma limite pour ce message. Dis « continue » pour que je poursuive."
		);
	});

	it('speaks French at its limit of tokens as well', async () => {
		// A first read of 1200 tokens takes the turn past its 1000, within its one tool call
		h.apisix.llm.script = pastTheLimit(
			{ content: LATE_CALL_MARKUP },
			{ promptTokens: 1000, completionTokens: 200 }
		);
		const { status, body } = await chatIn(h, { message: 'Lis-les toutes' }, 'notice-fr-tokens');
		expect(status).toBe(200);
		expect(body.answer).toBe(
			"J'ai fait 1 action pour ta demande, puis j'ai atteint ma limite pour ce message. Dis « continue » pour que je poursuive."
		);
		const noticed = h
			.logLines()
			.find((line) => line['reqId'] === 'notice-fr-tokens' && line['msg'] === 'token limit notice');
		expect(noticed).toMatchObject({ level: 30, actions: 1, reason: 'markup' });
	});
});
