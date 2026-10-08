import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	modelFor,
	QUESTION_CONTENT_KEY,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';

const OWNER = 'alice@test.local';
const IDENTITY_ROUTE = '/v1/assistants/me/owner-identity';
const DAY_MS = 86_400_000;
// How far the clock of the database may stand from the test's
const CLOCK_SKEW_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const QUESTION =
	"Ton identité de chiffrement n'est pas celle que je connais. C'est toi qui as réinitialisé ton identité ? Réponds par oui ou non dans ton prochain message.";
const QUESTION_START = "Ton identité de chiffrement n'est pas celle que je connais. C'est toi";

// What tells Alice's client which question a message asks, and until when
function markOf(r: ConsentRoom, eventId: string): unknown {
	const message = r.client.messages.find((m) => m.eventId === eventId);
	return message?.content[QUESTION_CONTENT_KEY];
}

// The event of Alice's room as the homeserver holds it
async function storedEvent(r: ConsentRoom, eventId: string): Promise<Record<string, unknown>> {
	const reply = await r.h.synapse.request(
		r.alice,
		'GET',
		`/_matrix/client/v3/rooms/${encodeURIComponent(r.room)}/event/${encodeURIComponent(eventId)}`
	);
	return reply.body;
}

describe('my assistant asks me whether I reset my identity myself, while the harness only reports', () => {
	let r: ConsentRoom;
	beforeAll(async () => {
		// A deployment in French that sets nothing about my sessions
		r = await startConsentRoom({ ASSISTANT_LOCALE: 'fr', ADMISSION_USER_PER_MINUTE: '100' });
		r.h.apisix.llm.script = modelFor({});
		// My first words hold the identity I have now
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Bonjour');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Bonjour');
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('asks me once, in a question marked for a day, and acts on my words meanwhile', async () => {
		const before = await r.client.masterKey();
		const after = await r.client.resetIdentity();
		expect(after).not.toBe(before);
		const asked = r.saying(QUESTION_START).length;
		let heard = r.saying('Heard:').length;
		const sentAt = Date.now();
		await r.client.sendText(r.room, 'Après ma réinitialisation');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Après ma réinitialisation');
		expect(await r.nextSaying(QUESTION_START, asked)).toBe(QUESTION);
		const question = r.saying(QUESTION_START).at(-1)?.eventId ?? '';
		const mark = markOf(r, question) as { id: unknown; expires_ts: number };
		expect(mark).toEqual({ id: expect.stringMatching(UUID), expires_ts: expect.any(Number) });
		expect(mark.expires_ts).toBeGreaterThanOrEqual(sentAt + DAY_MS - CLOCK_SKEW_MS);
		expect(mark.expires_ts).toBeLessThanOrEqual(Date.now() + DAY_MS + CLOCK_SKEW_MS);
		// What marks it went through the homeserver encrypted
		const stored = await storedEvent(r, question);
		expect(stored['type']).toBe('m.room.encrypted');
		expect(stored['content']).not.toHaveProperty([QUESTION_CONTENT_KEY]);
		// It waits for my answer: my next words are acted on, and it is not asked again
		heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Autre chose');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Autre chose');
		expect(r.saying(QUESTION_START)).toHaveLength(asked + 1);
		// The identity held is still the one before, and the API shows the new one
		const view = await r.h.api.get(OWNER, IDENTITY_ROUTE);
		expect(view.body).toMatchObject({
			pinned: { master_key: before, pinned_by: 'first_use' },
			published: { master_key: after }
		});
	});
});
