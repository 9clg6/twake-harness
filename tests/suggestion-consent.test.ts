import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { askSuggestionConsent, makeSuggestionResumeTool } from '../src/suggestions/consent.js';
import { makeConsentMetrics } from '../src/consents/metrics.js';
import { decidePendingCall, expireRequests } from '../src/consents/repository.js';
import { withPrincipal } from '../src/db/client.js';
import { ensurePrincipal } from '../src/principals/repository.js';
import type { SuggestPayload } from '../src/suggestions/job.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';

const ALICE = 'alice@test.local';
const BOB = 'bob@test.local';
const CALENDAR = { domain: 'calendar', level: 'read' } as const;

function payload(overrides: Partial<SuggestPayload> = {}): SuggestPayload {
	return {
		owner: ALICE,
		roomId: '!channel:test.local',
		eventId: '$event',
		at: Date.now(),
		quoted: [{ author: '@bob:test.local', email: BOB, text: 'Lunch on Monday at noon?' }],
		...overrides
	};
}

describe('a suggestion that lacks a permission asks for it', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness();
		await withPrincipal(h.db, { id: ALICE }, (tx) => ensurePrincipal(tx, { id: ALICE }));
	});
	afterAll(async () => {
		if (h !== undefined) await h.close();
	});

	const ask = (p: SuggestPayload) =>
		askSuggestionConsent(
			{ config: h.config, db: h.db, domains: new Map(), consentMetrics: makeConsentMetrics() },
			p,
			'en',
			CALENDAR
		);

	const jobs = async (): Promise<number> =>
		Number(
			(await h.db.sql<{ n: string }[]>`select count(*) as n from jobs where kind = 'suggest'`)[0]?.n
		);

	async function status(id: string): Promise<{ status: string; arguments: unknown }> {
		return withPrincipal(h.db, { id: ALICE }, async (tx) => {
			const rows = await tx.sql<{ status: string; arguments: unknown }[]>`
				select status, arguments from pending_calls where id = ${id}`;
			return rows[0] ?? { status: 'gone', arguments: null };
		});
	}

	it('asks once, naming the author and no message, then not while it waits, nor after a no', async () => {
		const first = await ask(payload());
		expect(first).not.toBeNull();
		const text = JSON.stringify(first?.request);
		expect(text).toContain(BOB);
		expect(text).not.toContain('Lunch on Monday');
		expect(await ask(payload({ eventId: '$other' }))).toBeNull();
		const id = first?.pendingCallId ?? '';
		await withPrincipal(h.db, { id: ALICE }, (tx) =>
			decidePendingCall(tx, ALICE, id, 'refused', '$no')
		);
		expect((await status(id)).arguments).toBeNull();
		expect(await ask(payload({ eventId: '$third' }))).toBeNull();
	});

	it('asks again once a question expired, and its yes queues the suggestion again while it is young', async () => {
		await withPrincipal(
			h.db,
			{ id: ALICE },
			(tx) => tx.sql`delete from pending_calls where owner = ${ALICE}`
		);
		const first = await ask(payload());
		await withPrincipal(h.db, { id: ALICE }, (tx) => expireRequests(tx, ALICE, 0));
		const again = await ask(payload({ eventId: '$again' }));
		expect(again).not.toBeNull();

		const tool = makeSuggestionResumeTool({ config: h.config });
		const context = {
			principalId: ALICE,
			actions: [],
			db: h.db,
			log: h.app.log
		};
		const before = await jobs();
		const young = await tool.run({ payload: payload({ eventId: '$young' }) }, context);
		expect(young.result).toEqual({ status: 'queued' });
		expect(await jobs()).toBe(before + 1);
		const old = await tool.run(
			{ payload: payload({ eventId: '$old', at: Date.now() - 11 * 60 * 1000 }) },
			context
		);
		expect(old.result).toEqual({ status: 'expired' });
		expect(await jobs()).toBe(before + 1);
		expect(first?.pendingCallId).not.toBe(again?.pendingCallId);
	});

	it('is no tool the model is given', () => {
		const tool = makeSuggestionResumeTool({ config: h.config });
		expect(tool.hidden).toBe(true);
	});
});
