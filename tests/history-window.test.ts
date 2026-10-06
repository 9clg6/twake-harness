import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { LlmMessage } from '../src/llm/client.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { echoScript } from './helpers/fake-apisix.js';

interface ChatReply {
	session_id: string;
	answer: string;
}

// A budget small enough that a few long exchanges overflow it
const BUDGET = 3_000;

describe('the history a turn shows the model', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness({ env: { TURN_HISTORY_MAX_CHARS: String(BUDGET) } });
	});
	afterAll(async () => {
		await h.close();
	});
	beforeEach(() => {
		h.apisix.llm.calls.length = 0;
		h.apisix.llm.script = echoScript;
	});

	async function chat(sub: string, message: string, sessionId?: string): Promise<ChatReply> {
		const res = await h.app.inject({
			method: 'POST',
			url: '/v1/chat',
			headers: { authorization: `Bearer ${await h.issuer.mint({ sub })}` },
			payload: sessionId === undefined ? { message } : { session_id: sessionId, message }
		});
		expect(res.statusCode).toBe(200);
		return res.json<ChatReply>();
	}

	async function storedMessages(sub: string, sessionId: string): Promise<LlmMessage[]> {
		const res = await h.app.inject({
			method: 'GET',
			url: `/v1/sessions/${sessionId}`,
			headers: { authorization: `Bearer ${await h.issuer.mint({ sub })}` }
		});
		expect(res.statusCode).toBe(200);
		return res.json<{ messages: LlmMessage[] }>().messages;
	}

	// What the model read in its last call, without the system prompt
	function lastPrompt(): readonly LlmMessage[] {
		const call = h.apisix.llm.calls.at(-1);
		if (call === undefined) throw new Error('the model was never called');
		return call.request.messages.filter((message) => message.role !== 'system');
	}

	function mentions(messages: readonly LlmMessage[], text: string): boolean {
		return messages.some((message) => (message.content ?? '').includes(text));
	}

	it('shows the model only the recent exchanges of a long conversation, and keeps them all', async () => {
		const first = await chat('alice', `OLDEST ${'a'.repeat(1_000)}`);
		const session = first.session_id;
		for (let i = 0; i < 3; i += 1) await chat('alice', `filler ${i} ${'b'.repeat(1_000)}`, session);
		await chat('alice', `RECENT ${'c'.repeat(1_000)}`, session);
		await chat('alice', 'What comes next?', session);

		const seen = lastPrompt();
		expect(mentions(seen, 'OLDEST')).toBe(false);
		expect(mentions(seen, 'RECENT')).toBe(true);
		expect(seen.at(-1)).toMatchObject({ role: 'user', content: 'What comes next?' });
		const windowed = h
			.logLines()
			.filter((line) => line['msg'] === 'history windowed')
			.at(-1);
		expect(windowed).toMatchObject({ historyMessages: 10, shownMessages: 2 });

		const stored = await storedMessages('alice', session);
		expect(stored).toHaveLength(12);
		expect(mentions(stored, 'OLDEST')).toBe(true);
		expect(stored.at(-1)).toMatchObject({ role: 'assistant', content: 'echo: What comes next?' });
	});

	it('never shows the model a tool result without the call it answers', async () => {
		const first = await chat('bob', 'OLDEST of the tool conversation');
		const session = first.session_id;
		// One exchange where the model saves a long note through a tool, then answers
		h.apisix.llm.calls.length = 0;
		h.apisix.llm.script = (_request, index) =>
			index === 0
				? {
						toolCalls: [
							{
								id: 'call_note',
								type: 'function',
								function: {
									name: 'memory',
									arguments: JSON.stringify({ action: 'add', content: 'n'.repeat(1_200) })
								}
							}
						]
					}
				: { content: `Noted. ${'d'.repeat(600)}` };
		await chat('bob', 'Keep this', session);
		h.apisix.llm.script = echoScript;
		await chat('bob', `RECENT ${'c'.repeat(900)}`, session);
		await chat('bob', 'And now?', session);

		const seen = lastPrompt();
		expect(seen[0]?.role).toBe('user');
		expect(mentions(seen, 'OLDEST')).toBe(false);
		const called = new Set<string>();
		for (const message of seen) {
			for (const call of message.tool_calls ?? []) called.add(call.id);
			if (message.role === 'tool') expect(called.has(message.tool_call_id ?? '')).toBe(true);
		}
	});

	it('still shows the last exchange when it alone is over the budget', async () => {
		const first = await chat('carol', 'OLDEST of a short start');
		const session = first.session_id;
		await chat('carol', `HUGE ${'h'.repeat(4_000)}`, session);
		await chat('carol', 'Still there?', session);

		const seen = lastPrompt();
		expect(mentions(seen, 'OLDEST')).toBe(false);
		expect(seen.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
		expect(mentions(seen, 'HUGE')).toBe(true);
		expect(seen.at(-1)).toMatchObject({ role: 'user', content: 'Still there?' });
	});

	it('still nudges the model to save memory when the window shows only the last turns', async () => {
		const nudge = 'You have saved nothing to memory for a while';
		h.apisix.llm.script = (request) =>
			(request.messages[0]?.content ?? '').includes(nudge)
				? { content: 'nudged' }
				: echoScript(request, 0);
		const first = await chat('dave', `turn 0 ${'e'.repeat(1_000)}`);
		let answer = first.answer;
		for (let i = 1; i < 10; i += 1) {
			answer = (await chat('dave', `turn ${i} ${'e'.repeat(1_000)}`, first.session_id)).answer;
			if (i < 9) expect(answer).not.toBe('nudged');
		}
		expect(mentions(lastPrompt(), 'turn 0')).toBe(false);
		expect(answer).toBe('nudged');
	});
});
