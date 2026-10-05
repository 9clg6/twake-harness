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
