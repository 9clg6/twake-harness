import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_ACTIONS } from '../src/principals/repository.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';

describe('identity at the HTTP boundary', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness();
	});
	afterAll(async () => {
		await h.close();
	});

	async function whoAmI(token: string | null): Promise<{ status: number; body: unknown }> {
		const headers: Record<string, string> =
			token === null ? {} : { authorization: `Bearer ${token}` };
		const res = await h.app.inject({ method: 'GET', url: '/v1/me', headers });
		return { status: res.statusCode, body: res.json() };
	}

	it('answers the health check without any token', async () => {
		const res = await h.app.inject({ method: 'GET', url: '/health' });
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ status: 'ok' });
	});

	it('provisions a new identity with the default rights on its first request', async () => {
		const first = await whoAmI(await h.issuer.mint({ sub: 'alice' }));
		expect(first.status).toBe(200);
		expect(first.body).toEqual({ user: 'alice', actions: DEFAULT_ACTIONS });
		const again = await whoAmI(await h.issuer.mint({ sub: 'alice' }));
		expect(again.body).toEqual({ user: 'alice', actions: DEFAULT_ACTIONS });
	});

	it('refuses a missing token', async () => {
		expect((await whoAmI(null)).status).toBe(401);
	});

	it('refuses an expired token', async () => {
		const now = Math.floor(Date.now() / 1000);
		const token = await h.issuer.mint({ sub: 'expired', iat: now - 7200, exp: now - 3600 });
		expect((await whoAmI(token)).status).toBe(401);
	});

	it('refuses a tampered token', async () => {
		const token = await h.issuer.mint({ sub: 'alice' });
		const [header, , signature] = token.split('.');
		const payload = Buffer.from(JSON.stringify({ sub: 'mallory' })).toString('base64url');
		expect((await whoAmI(`${header}.${payload}.${signature}`)).status).toBe(401);
	});

	it('refuses an unsigned token', async () => {
		expect((await whoAmI(h.issuer.mintUnsigned({ sub: 'alice' }))).status).toBe(401);
	});

	it('refuses a token signed by another key', async () => {
		expect((await whoAmI(await h.issuer.mintWithForeignKey({ sub: 'alice' }))).status).toBe(401);
	});

	it('refuses a token for another audience', async () => {
		expect((await whoAmI(await h.issuer.mint({ sub: 'alice', aud: 'other' }))).status).toBe(401);
	});

	it('refuses a token from another issuer', async () => {
		expect(
			(await whoAmI(await h.issuer.mint({ sub: 'alice', iss: 'https://other.local' }))).status
		).toBe(401);
	});

	it('provisions nothing when the token is refused', async () => {
		await whoAmI(await h.issuer.mint({ sub: 'ghost', aud: 'other' }));
		const rows = await h.db.sql`select count(*)::int as n from principals where id = 'ghost'`;
		expect(rows[0]?.['n']).toBe(0);
	});

	it('refuses an empty or oversized subject', async () => {
		expect((await whoAmI(await h.issuer.mint({ sub: '' }))).status).toBe(401);
		expect((await whoAmI(await h.issuer.mint({ sub: 'x'.repeat(129) }))).status).toBe(401);
	});
});
