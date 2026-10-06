import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';

describe('the api behind the gateway only', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness({ env: { GATEWAY_SHARED_SECRET: 'gateway-secret' } });
	});
	afterAll(async () => {
		await h.close();
	});

	async function me(headers: Record<string, string>): Promise<number> {
		const token = await h.issuer.mint({ sub: 'alice' });
		const res = await h.app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: { authorization: `Bearer ${token}`, ...headers }
		});
		return res.statusCode;
	}

	it('refuses a request that does not carry the secret the gateway sets, before any identity work', async () => {
		expect(await me({})).toBe(403);
		expect(await me({ 'x-twake-gateway': 'not-it' })).toBe(403);
		expect(
			h.logLines().some((l) => l['msg'] === 'request refused' && l['reason'] === 'gateway')
		).toBe(true);
		expect(await h.db.sql`select count(*)::int as n from principals`).toEqual([{ n: 0 }]);
	});

	it('serves a request the gateway forwarded', async () => {
		expect(await me({ 'x-twake-gateway': 'gateway-secret' })).toBe(200);
	});

	it('keeps the health check and the metrics open to the cluster', async () => {
		expect((await h.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
		expect((await h.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
	});
});
