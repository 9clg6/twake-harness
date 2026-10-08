import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';

describe('a list of audiences', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness({ env: { AUTH_AUDIENCE: 'twake-harness, twakespace' } });
	});
	afterAll(async () => {
		await h.close();
	});

	async function status(aud: string): Promise<number> {
		const token = await h.issuer.mint({ sub: 'alice@test.local', aud });
		const res = await h.app.inject({
			method: 'GET',
			url: '/v1/me',
			headers: { authorization: `Bearer ${token}` }
		});
		return res.statusCode;
	}

	it('accepts a token for any audience of the list, and for no other', async () => {
		expect(h.config.auth.audience).toEqual(['twake-harness', 'twakespace']);
		expect(await status('twake-harness')).toBe(200);
		expect(await status('twakespace')).toBe(200);
		expect(await status('somebody-else')).toBe(401);
	});
});
