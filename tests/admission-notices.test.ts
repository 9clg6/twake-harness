import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeSettableClock } from './helpers/clock.js';
import { startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';

// What my assistant tells me in French when admission refuses my message
const DAY_SPENT =
	"J'ai atteint ma limite du jour et je ne peux pas prendre ce message. Elle se lève à minuit : renvoie-le à ce moment-là.";

// What my assistant says in my room next, once I sent it a message
async function replyTo(r: ConsentRoom, text: string): Promise<string> {
	const seen = r.saying('').length;
	await r.client.sendText(r.room, text);
	return r.nextSaying('', seen);
}

describe('a French deployment in Europe/Paris', () => {
	// Each test starts on a day of its own, which the turns of the others never spent
	const clock = makeSettableClock('2026-10-08T08:00:00Z');
	let r: ConsentRoom;
	beforeAll(async () => {
		// A day of one turn
		r = await startConsentRoom(
			{
				ASSISTANT_LOCALE: 'fr',
				ASSISTANT_TIMEZONE: 'Europe/Paris',
				ADMISSION_USER_DAILY_TOKENS: '1',
				ADMISSION_USER_PER_MINUTE: '100'
			},
			{ clock }
		);
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('tells me my limit for the day is reached, and that it lifts at midnight', async () => {
		clock.set('2026-10-08T08:00:00Z');
		expect(await replyTo(r, 'Bonjour')).toBe('echo: Bonjour');
		expect(await replyTo(r, 'Encore une chose')).toBe(DAY_SPENT);
	});

	it('starts my day again at midnight in Paris, not at midnight UTC', async () => {
		// 23:30 in Paris, 21:30 UTC: the one turn of my day, then my limit
		clock.set('2026-10-10T21:30:00Z');
		expect(await replyTo(r, 'Bonsoir')).toBe('echo: Bonsoir');
		expect(await replyTo(r, 'Encore une chose')).toBe(DAY_SPENT);
		// 00:05 in Paris, the same day still in UTC: my new day
		clock.set('2026-10-10T22:05:00Z');
		expect(await replyTo(r, 'Et maintenant ?')).toBe('echo: Et maintenant ?');
		expect(await replyTo(r, 'Encore une chose')).toBe(DAY_SPENT);
		// 02:30 in Paris, past midnight UTC: the same day of mine
		clock.set('2026-10-11T00:30:00Z');
		expect(await replyTo(r, 'Et là ?')).toBe(DAY_SPENT);
	});
});
