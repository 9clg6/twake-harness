import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';

describe('structured logs', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness();
	});
	afterAll(async () => {
		await h.close();
	});

	it('keeps the caller correlation id on the response and on every log line', async () => {
		const res = await h.app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: { 'x-request-id': 'corr-123', authorization: 'Bearer nope' }
		});
		expect(res.headers['x-request-id']).toBe('corr-123');
		const lines = h.logLines().filter((line) => line['reqId'] === 'corr-123');
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines.some((line) => line['msg'] === 'request refused')).toBe(true);
	});

	it('generates a correlation id when the caller sends none', async () => {
		const res = await h.app.inject({ method: 'GET', url: '/health' });
		const id = res.headers['x-request-id'];
		expect(typeof id).toBe('string');
		expect(h.logLines().some((line) => line['reqId'] === id)).toBe(true);
	});
});

// Messages reach the harness end-to-end encrypted and are decrypted only inside it: what a user
// says, what the model answers or thinks, and what a tool receives must never reach a log line at
// info, which is the production level. Debug keeps the full exchange for local troubleshooting.
const USER_MARKER = 'USER-MARKER-7f3a';
const ANSWER_MARKER = 'ANSWER-MARKER-91c2';
const REASONING_MARKER = 'REASONING-MARKER-4d8e';
const TOOL_MARKER = 'TOOL-MARKER-b6a0';
const MARKERS = [USER_MARKER, ANSWER_MARKER, REASONING_MARKER, TOOL_MARKER];

async function chat(h: TestHarness, message: string): Promise<number> {
	const res = await h.app.inject({
		method: 'POST',
		url: '/v1/chat',
		headers: { authorization: `Bearer ${await h.issuer.mint({ sub: 'alice' })}` },
		payload: { message }
	});
	return res.statusCode;
}

// A turn answered with reasoning, then a turn that ends on a clarification asked through a tool
async function converse(h: TestHarness): Promise<void> {
	h.apisix.llm.script = () => ({
		reasoning: `thinking ${REASONING_MARKER}`,
		content: `the answer ${ANSWER_MARKER}`
	});
	expect(await chat(h, `a question ${USER_MARKER}`)).toBe(200);
	h.apisix.llm.script = () => ({
		toolCalls: [
			{
				id: 'call_1',
				type: 'function',
				function: {
					name: 'clarify',
					arguments: JSON.stringify({ question: `which one ${TOOL_MARKER}?` })
				}
			}
		]
	});
	expect(await chat(h, 'open it')).toBe(200);
}

function textOf(lines: readonly Record<string, unknown>[]): string {
	return lines.map((line) => JSON.stringify(line)).join('\n');
}

describe('conversation content at the production log level', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness();
		await converse(h);
	});
	afterAll(async () => {
		await h.close();
	});

	it('writes no message, answer, reasoning or tool argument to the logs', () => {
		const text = textOf(h.logLines());
		for (const marker of MARKERS) expect(text).not.toContain(marker);
	});

	it('still reports every turn, model call and tool call with its metadata', () => {
		const lines = h.logLines();
		const finished = lines.filter((line) => line['msg'] === 'turn finished');
		expect(finished).toHaveLength(2);
		expect(finished[0]?.['answerLength']).toBe(`the answer ${ANSWER_MARKER}`.length);
		const asked = lines.find((line) => line['msg'] === 'model asked');
		expect(asked?.['messageCount']).toBeGreaterThanOrEqual(2);
		expect(asked?.['characters']).toBeGreaterThan(0);
		const answered = lines.find(
			(line) => line['msg'] === 'model answered' && line['hasReasoning'] === true
		);
		expect(answered?.['answerLength']).toBe(`the answer ${ANSWER_MARKER}`.length);
		const tool = lines.find((line) => line['msg'] === 'tool called');
		expect(tool?.['tool']).toBe('clarify');
		expect(tool?.['status']).toBe('final');
		expect(typeof tool?.['durationMs']).toBe('number');
	});
});

describe('conversation content at the debug level', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness({ env: { LOG_LEVEL: 'debug' } });
		await converse(h);
	});
	afterAll(async () => {
		await h.close();
	});

	it('keeps the full exchange in debug lines for local troubleshooting', () => {
		const text = textOf(h.logLines().filter((line) => line['level'] === 20));
		for (const marker of MARKERS) expect(text).toContain(marker);
	});

	it('still keeps it out of every line at info and above', () => {
		const text = textOf(h.logLines().filter((line) => Number(line['level']) >= 30));
		for (const marker of MARKERS) expect(text).not.toContain(marker);
	});
});
