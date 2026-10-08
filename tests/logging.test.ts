import { createServer } from 'node:http';
import { doHttpRequest, LogService } from 'matrix-bot-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { step } from '../src/matrix/crypto-requests.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { modelUsing } from './helpers/consent-room.js';
import { grantConsent } from './helpers/consents.js';
import { CALENDAR_CATALOG } from './helpers/fake-apisix.js';

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
// info, which is the production level, but for the from and days of a list of calendar events, the
// days it reads, in the shape the contract takes them (see below). Debug keeps the full exchange
// for local troubleshooting.
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

// The from and days of a list of the owner's events reach info, so that the days the model took for
// "today" or "tomorrow" can be checked, but only in the shape the contract takes them: the model
// writes them, and any other text written there would carry the conversation into the logs
describe('the days a list of calendar events reads, at the production log level', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness();
		h.apisix.contracts.spec = CALENDAR_CATALOG;
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(4);
		// Alice already let her assistant read her calendar
		await grantConsent(h.db, 'alice', 'calendar', 'read');
		h.apisix.contracts.handler = () => ({
			status: 200,
			body: { time_zone: 'Europe/Paris', events: [], truncated: false }
		});
	});
	afterAll(async () => {
		await h.close();
	});

	// The info line of the one call a turn made to list Alice's events with these arguments
	async function lineOfList(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		const before = h.logLines().length;
		h.apisix.llm.script = modelUsing('list_calendar_events', args);
		expect(await chat(h, 'What do I have tomorrow?')).toBe(200);
		const lines = h.logLines().slice(before);
		const called = lines.filter((line) => line['msg'] === 'contract called');
		expect(called).toHaveLength(1);
		return called[0] ?? {};
	}

	it('gives the day and the number of days of a list as sent, in the shape the contract takes', async () => {
		expect(await lineOfList({ from: '2026-10-09', days: 1 })).toMatchObject({
			level: 30,
			from: '2026-10-09',
			days: '1'
		});
	});

	it('names an argument of another shape, never with what the model wrote there', async () => {
		const line = await lineOfList({ from: `tomorrow ${TOOL_MARKER}`, days: 32 });
		expect(line).toMatchObject({ level: 30, malformedArguments: ['from', 'days'] });
		expect(line).not.toHaveProperty('from');
		expect(line).not.toHaveProperty('days');
		// A day written as a list goes once per item: the line gives none of them
		const repeated = await lineOfList({ from: ['2026-10-09', TOOL_MARKER] });
		expect(repeated).toMatchObject({ level: 30, malformedArguments: ['from'] });
		expect(repeated).not.toHaveProperty('from');
		expect(textOf(h.logLines())).not.toContain(TOOL_MARKER);
	});
});

// The matrix role sends its consumer key with every request of the SDK, and the SDK its access
// token: neither may reach a log line, whatever shape the failure of such a request takes.
const CONSUMER_KEY = 'fake-consumer-key-0d4f';
const ACCESS_TOKEN = 'fake-access-token-8b2e';

interface Upstream {
	readonly url: string;
	close(): Promise<void>;
}

// An upstream answering every request the same way: a gateway whose upstream is down, or Synapse
// refusing the request
async function startUpstream(status: number, type: string, body: string): Promise<Upstream> {
	const server = createServer((_req, res) => {
		res.writeHead(status, { 'content-type': type });
		res.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('the upstream did not bind to a TCP port');
	}
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((resolve) => {
				// The SDK keeps its connections alive
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}

// A request of the matrix role through the SDK, with the headers the role and the SDK send
function sdkRequest(upstream: Upstream): Promise<unknown> {
	return doHttpRequest(upstream.url, 'GET', '/_matrix/client/v3/account/whoami', null, null, {
		apikey: CONSUMER_KEY,
		Authorization: `Bearer ${ACCESS_TOKEN}`
	});
}

// What a failed request rejects with: the SDK's rejection, or an error raised over it
async function rejectionOf(request: () => Promise<unknown>): Promise<unknown> {
	try {
		await request();
	} catch (rejection: unknown) {
		return rejection;
	}
	throw new Error('the request was expected to fail');
}

describe('failed requests in the logs', () => {
	let h: TestHarness;
	let gateway: Upstream;
	let synapse: Upstream;
	beforeAll(async () => {
		// The SDK reports the failures on the console by itself
		LogService.muteModule('MatrixHttpClient');
		h = await startTestHarness();
		gateway = await startUpstream(502, 'text/html', '<html><body>502 Bad Gateway</body></html>');
		synapse = await startUpstream(
			403,
			'application/json',
			JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'Not allowed' })
		);
	});
	afterAll(async () => {
		await gateway.close();
		await synapse.close();
		await h.close();
	});

	function lineOf(msg: string): Record<string, unknown> {
		const line = h.logLines().find((candidate) => candidate['msg'] === msg);
		if (line === undefined) throw new Error(`no log line "${msg}"`);
		return line;
	}

	function expectNoSecretIn(line: Record<string, unknown>): void {
		const text = JSON.stringify(line);
		expect(text).not.toContain(CONSUMER_KEY);
		expect(text).not.toContain(ACCESS_TOKEN);
	}

	it('logs the status of a request the gateway failed, never its headers', async () => {
		h.app.log.error({ err: await rejectionOf(() => sdkRequest(gateway)) }, 'gateway failure');
		const line = lineOf('gateway failure');
		expect(line['err']).toEqual({
			type: 'IncomingMessage',
			statusCode: 502,
			statusMessage: 'Bad Gateway'
		});
		expectNoSecretIn(line);
	});

	it('logs an error carrying such a response with its status, not the response', async () => {
		const err = Object.assign(new Error('whoami failed'), {
			response: await rejectionOf(() => sdkRequest(gateway))
		});
		h.app.log.warn({ err }, 'wrapped failure');
		const line = lineOf('wrapped failure');
		expect(line['err']).toMatchObject({ type: 'Error', message: 'whoami failed', statusCode: 502 });
		expect(line['err']).not.toHaveProperty('response');
		expectNoSecretIn(line);
	});

	it('keeps the reports of the SDK readable, without the headers of what failed', async () => {
		h.app.log.error(
			{
				module: 'Appservice',
				rest: [
					'(REQ-1)',
					await rejectionOf(() => sdkRequest(gateway)),
					{ errcode: 'M_UNKNOWN', error: 'Unknown error' }
				]
			},
			'matrix sdk'
		);
		const line = lineOf('matrix sdk');
		expect(line['rest']).toEqual([
			'(REQ-1)',
			{ type: 'IncomingMessage', statusCode: 502, statusMessage: 'Bad Gateway' },
			{ errcode: 'M_UNKNOWN', error: 'Unknown error' }
		]);
		expectNoSecretIn(line);
	});

	it('names the status of a failed request an error was raised over, not its headers', async () => {
		const err = await rejectionOf(() => step('signing keys upload', () => sdkRequest(gateway)));
		h.app.log.error({ err }, 'crypto step failure');
		const line = lineOf('crypto step failure');
		expect(line['err']).toMatchObject({
			type: 'Error',
			cause: { type: 'IncomingMessage', statusCode: 502, statusMessage: 'Bad Gateway' }
		});
		expectNoSecretIn(line);
	});

	it('keeps what the homeserver answered when it refused a request', async () => {
		h.app.log.warn(
			{ err: await rejectionOf(() => sdkRequest(synapse)) },
			'request refused by synapse'
		);
		const line = lineOf('request refused by synapse');
		expect(line['err']).toMatchObject({
			type: 'MatrixError',
			message: 'M_FORBIDDEN: Not allowed',
			statusCode: 403,
			errcode: 'M_FORBIDDEN',
			error: 'Not allowed'
		});
		expectNoSecretIn(line);
	});
});
