import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeClient } from './helpers/client.js';
import { makeSettableClock } from './helpers/clock.js';
import { startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { echoScript, lastUserContent } from './helpers/fake-apisix.js';
import { eventually } from './helpers/feedback.js';

// What my assistant tells me in French when admission refuses my message
const DAY_SPENT =
	"J'ai atteint ma limite du jour et je ne peux pas prendre ce message. Elle se lève à minuit : renvoie-le à ce moment-là.";
const TOO_MANY =
	"J'ai reçu trop de messages d'un coup et je ne peux pas prendre celui-ci. Attends une minute, puis renvoie-le.";
const PLATFORM_BUSY =
	'La plateforme reçoit beaucoup de demandes en ce moment et je ne peux pas prendre ce message. Renvoie-le dans un instant.';

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
		// A day of one turn, and no turn of mine waits for another
		r = await startConsentRoom(
			{
				ASSISTANT_LOCALE: 'fr',
				ASSISTANT_TIMEZONE: 'Europe/Paris',
				ADMISSION_USER_DAILY_TOKENS: '1',
				ADMISSION_USER_QUEUE: '0',
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

	it('tells me it got too many messages at once, and to wait a minute', async () => {
		clock.set('2026-10-09T08:00:00Z');
		// My assistant works for me through the API on every replica, its model held, when my message
		// comes in the room
		let answer: () => void = () => undefined;
		const answered = new Promise<void>((resolve) => {
			answer = resolve;
		});
		let working = 0;
		r.h.apisix.llm.script = (request) => {
			working += 1;
			return { content: `echo: ${lastUserContent(request)}`, hold: answered };
		};
		const chats = Promise.all(
			r.h.apps.map((app) =>
				makeClient({ app, apps: [app], issuer: r.h.issuer }).post('alice@test.local', '/v1/chat', {
					message: 'Prends ton temps'
				})
			)
		);
		try {
			expect(await eventually(() => working === r.h.apps.length)).toBe(true);
			expect(await replyTo(r, 'Et ceci ?')).toBe(TOO_MANY);
		} finally {
			// Answered before the clock moves on, so that their tokens count in this day
			answer();
			await chats;
			r.h.apisix.llm.script = echoScript;
		}
		expect((await chats).every((chat) => chat.status === 200)).toBe(true);
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

describe('a platform with many requests', () => {
	let r: ConsentRoom;
	beforeAll(async () => {
		// One turn a minute on the whole platform
		r = await startConsentRoom({ ASSISTANT_LOCALE: 'fr', ADMISSION_GLOBAL_PER_MINUTE: '1' });
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('tells me the platform has many requests, and to send my message again in a moment', async () => {
		// Someone else's turn takes the platform's minute
		expect((await r.h.api.post('bob@test.local', '/v1/chat', { message: 'Bonjour' })).status).toBe(
			200
		);
		expect(await replyTo(r, 'Bonjour')).toBe(PLATFORM_BUSY);
	});
});
