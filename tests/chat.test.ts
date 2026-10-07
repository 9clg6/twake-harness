import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';
import { echoScript, type ChatRequest } from './helpers/fake-apisix.js';

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

	it('stops a model that keeps calling tools after the allowed number of calls', async () => {
		h.apisix.llm.script = () => ({
			toolCalls: [
				{
					id: 'loop',
					type: 'function',
					function: { name: 'unknown_tool', arguments: '{}' }
				}
			]
		});
		const { status, body } = await chat('alice', { message: 'loop' });
		expect(status).toBe(502);
		expect(body.error).toBe('execution failed');
		expect(h.apisix.llm.calls.length).toBeLessThanOrEqual(7);
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
