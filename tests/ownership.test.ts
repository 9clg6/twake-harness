import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withPrincipal } from '../src/db/client.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';

describe('ownership enforced by the database', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness();
		for (const sub of ['alice', 'bob']) {
			await h.app.inject({
				method: 'GET',
				url: '/v1/me',
				headers: { authorization: `Bearer ${await h.issuer.mint({ sub })}` }
			});
		}
	});
	afterAll(async () => {
		await h.close();
	});

	it('shows a principal only its own rows', async () => {
		const seenByBob = await withPrincipal(
			h.db,
			{ id: 'bob' },
			(tx) => tx.sql`select id from principals order by id`
		);
		expect(seenByBob.map((r) => r['id'])).toEqual(['bob']);
		const seenByAlice = await withPrincipal(
			h.db,
			{ id: 'alice' },
			(tx) => tx.sql`select id from principals order by id`
		);
		expect(seenByAlice.map((r) => r['id'])).toEqual(['alice']);
	});

	it('shows nothing when no principal is set', async () => {
		const rows = await h.db.sql`select id from principals`;
		expect(rows).toHaveLength(0);
	});

	it('refuses a row written for someone else', async () => {
		await expect(
			withPrincipal(
				h.db,
				{ id: 'bob' },
				(tx) => tx.sql`insert into principals (id, actions) values ('carol', '[]'::jsonb)`
			)
		).rejects.toThrow(/row-level security/);
	});
});
