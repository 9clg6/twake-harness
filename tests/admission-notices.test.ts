import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
	let r: ConsentRoom;
	beforeAll(async () => {
		// A day of one turn
		r = await startConsentRoom({
			ASSISTANT_LOCALE: 'fr',
			ASSISTANT_TIMEZONE: 'Europe/Paris',
			ADMISSION_USER_DAILY_TOKENS: '1',
			ADMISSION_USER_PER_MINUTE: '100'
		});
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('tells me my limit for the day is reached, and that it lifts at midnight', async () => {
		expect(await replyTo(r, 'Bonjour')).toBe('echo: Bonjour');
		expect(await replyTo(r, 'Encore une chose')).toBe(DAY_SPENT);
	});
});
