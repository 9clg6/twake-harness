import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expireOverdueRequests } from '../src/consents/expiry.js';
import {
	modelUsing,
	readCatalog,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';

const EXPIRED = 'This request has expired, so I did nothing. Ask me again if you still need it.';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('a question I leave unanswered expires', () => {
	let r: ConsentRoom;
	beforeAll(async () => {
		// Its lifetime is a second here, and a day by default
		r = await startConsentRoom({ CONSENT_REQUEST_LIFETIME_MS: '1000' });
		r.h.apisix.contracts.spec = readCatalog(['mail', 'drive', 'notes']);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(3);
		r.h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('tells me so when I answer too late, by tap or in words, and runs nothing', async () => {
		r.h.apisix.llm.script = modelUsing('search_mail', { q: 'budget' });
		let seen = r.questions().length;
		await r.client.sendText(r.room, 'Find the budget in my mail');
		const question = await r.nextQuestion(seen);
		await sleep(1500);
		let notices = r.saying('This request has expired').length;
		await r.client.react(r.room, question, '✅ YES');
		expect(await r.nextSaying('This request has expired', notices)).toBe(EXPIRED);

		r.h.apisix.llm.script = modelUsing('search_drive', { q: 'plan' });
		seen = r.questions().length;
		await r.client.sendText(r.room, 'Find my plan in my drive');
		await r.nextQuestion(seen);
		await sleep(1500);
		notices = r.saying('This request has expired').length;
		await r.client.sendText(r.room, 'yes');
		expect(await r.nextSaying('This request has expired', notices)).toBe(EXPIRED);

		expect(r.h.apisix.contracts.calls).toHaveLength(0);
		// An expired call keeps nothing of what it would have sent
		expect(await r.callsTo('mail')).toEqual([{ status: 'expired', arguments: null }]);
		expect(await r.callsTo('drive')).toEqual([{ status: 'expired', arguments: null }]);
	});

	it('erases what a call left unanswered would have sent, once its lifetime is over', async () => {
		r.h.apisix.llm.script = modelUsing('search_notes', { q: 'budget' });
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Search my notes for the budget');
		const question = await r.nextQuestion(seen);
		expect(await r.callsTo('notes')).toEqual([{ status: 'open', arguments: { q: 'budget' } }]);
		await sleep(1500);
		// The worker role's hourly pass, while I say nothing
		const app = r.h.apps[0];
		if (app === undefined) throw new Error('no api role');
		await expireOverdueRequests(r.h.db, app.log, 1000, app.agent.consentMetrics);
		expect(await r.callsTo('notes')).toEqual([{ status: 'expired', arguments: null }]);
		// My answer, when it comes, gets the notice
		const notices = r.saying('This request has expired').length;
		await r.client.react(r.room, question, '✅ YES');
		expect(await r.nextSaying('This request has expired', notices)).toBe(EXPIRED);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});
});
