import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';

// No call has this id: a token let through gets a 404, one refused a 401
const UNKNOWN_CALL = '/v1/pending-calls/00000000-0000-4000-8000-000000000000';

async function statusOf(
	h: TestHarness,
	aud: string,
	method: 'GET' | 'POST',
	url: string
): Promise<number> {
	const token = await h.issuer.mint({ sub: 'alice@test.local', aud });
	const res = await h.app.inject({
		method,
		url,
		headers: { authorization: `Bearer ${token}` },
		...(method === 'POST' ? { payload: {} } : {})
	});
	return res.statusCode;
}

describe('the audiences that answer a call', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness({ env: { AUTH_ANSWER_AUDIENCES: 'twakespace, other-buttons' } });
	});
	afterAll(async () => {
		await h.close();
	});

	it('lets a token of one of them say yes or no to a call, and nothing else', async () => {
		expect(h.config.auth.answerAudiences).toEqual(['twakespace', 'other-buttons']);
		expect(await statusOf(h, 'twakespace', 'POST', `${UNKNOWN_CALL}/approve`)).toBe(404);
		expect(await statusOf(h, 'other-buttons', 'POST', `${UNKNOWN_CALL}/refuse`)).toBe(404);
		expect(await statusOf(h, 'twakespace', 'GET', '/v1/me')).toBe(401);
		expect(await statusOf(h, 'twakespace', 'GET', '/v1/pending-calls')).toBe(401);
		expect(await statusOf(h, 'twakespace', 'POST', '/v1/chat')).toBe(401);
	});

	it('still takes the harness audience everywhere, and no other audience anywhere', async () => {
		expect(await statusOf(h, h.issuer.audience, 'GET', '/v1/me')).toBe(200);
		expect(await statusOf(h, h.issuer.audience, 'POST', `${UNKNOWN_CALL}/approve`)).toBe(404);
		expect(await statusOf(h, 'somebody-else', 'POST', `${UNKNOWN_CALL}/approve`)).toBe(401);
		expect(await statusOf(h, 'somebody-else', 'GET', '/v1/me')).toBe(401);
	});
});

describe('without audiences to answer a call', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness();
	});
	afterAll(async () => {
		await h.close();
	});

	it('takes the harness audience alone, on the yes and the no too', async () => {
		expect(h.config.auth.answerAudiences).toEqual([]);
		expect(await statusOf(h, 'twakespace', 'POST', `${UNKNOWN_CALL}/approve`)).toBe(401);
		expect(await statusOf(h, 'twakespace', 'POST', `${UNKNOWN_CALL}/refuse`)).toBe(401);
		expect(await statusOf(h, h.issuer.audience, 'POST', `${UNKNOWN_CALL}/refuse`)).toBe(404);
	});
});
