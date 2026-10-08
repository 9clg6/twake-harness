import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	modelFor,
	QUESTION_CONTENT_KEY,
	readCatalog,
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
const ADOPTED =
	"C'est noté : ta nouvelle identité est désormais celle que je connais, et je ne signale plus tes messages.";
const REJECTED =
	"Alors quelqu'un d'autre l'a peut-être réinitialisée : change ton mot de passe dès maintenant et préviens ton administrateur. Je garde l'identité que je connaissais, et je continue de te répondre comme avant.";
// What a request about a first call to an application starts with, in French
const REQUEST_START = "C'est la première fois";

const EN_QUESTION =
	'Your encryption identity is not the one I know. Did you reset your identity yourself? Answer yes or no in your next message.';
const EN_QUESTION_START = 'Your encryption identity is not the one I know. Did you';
const EN_REJECTED =
	'Then someone else may have reset it: change your password now and warn your administrator. I keep the identity I knew, and I go on answering you as before.';

interface Mark {
	readonly id: string;
	readonly expires_ts: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Until a question expired, by the end its mark gives, and a second more
async function pastExpiry(mark: Mark): Promise<void> {
	await sleep(Math.max(0, mark.expires_ts - Date.now()) + 1_000);
}

// The line the matrix role logged with a message, once it did
async function logged(
	r: ConsentRoom,
	msg: string,
	eventId: string
): Promise<Record<string, unknown>> {
	for (let i = 0; i < 120; i += 1) {
		const line = r.h.logLines().find((l) => l['eventId'] === eventId && l['msg'] === msg);
		if (line !== undefined) return line;
		await sleep(250);
	}
	throw new Error(`nothing logged as ${msg} for ${eventId}`);
}

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
		r.h.apisix.contracts.spec = readCatalog(['notes']);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(1);
		r.h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
		r.h.apisix.llm.script = modelFor({
			'Cherche le budget dans mes notes': { tool: 'search_notes', args: { q: 'budget' } }
		});
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

	it('holds my new identity once I answer yes, and flags my words from it no more', async () => {
		// I reset it once more: the question is about this one
		const after = await r.client.resetIdentity();
		const asked = r.saying(QUESTION_START).length;
		let heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Me revoilà');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Me revoilà');
		expect(await r.nextSaying(QUESTION_START, asked)).toBe(QUESTION);
		const adopted = r.saying(ADOPTED).length;
		await r.client.sendText(r.room, 'oui');
		expect(await r.nextSaying(ADOPTED, adopted)).toBe(ADOPTED);
		// The harness holds it now, as the API would once I accepted it there
		const view = await r.h.api.get(OWNER, IDENTITY_ROUTE);
		expect(view.body).toEqual({
			pinned: { master_key: after, pinned_by: 'chat', pinned_at: expect.any(String) },
			published: null
		});
		// My words from it are verified, and nothing tells me about them any more
		const said = r.client.messages.filter((m) => m.sender === r.assistantId).length;
		heard = r.saying('Heard:').length;
		const thanks = await r.client.sendText(r.room, 'Merci');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Merci');
		expect(await logged(r, 'owner device verified', thanks)).toMatchObject({
			signed: true,
			identity: 'pinned'
		});
		expect(r.client.messages.filter((m) => m.sender === r.assistantId)).toHaveLength(said + 1);
		// My yes was an answer: it started no turn of its own
		expect(r.saying('Heard: oui')).toHaveLength(0);
	});

	it('keeps the identity it knew when I answer no, tells me what to do, and goes on answering me', async () => {
		const before = await r.client.masterKey();
		const after = await r.client.resetIdentity();
		const asked = r.saying(QUESTION_START).length;
		let heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Coucou');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Coucou');
		expect(await r.nextSaying(QUESTION_START, asked)).toBe(QUESTION);
		const advised = r.saying(REJECTED).length;
		await r.client.sendText(r.room, 'non');
		expect(await r.nextSaying(REJECTED, advised)).toBe(REJECTED);
		const view = await r.h.api.get(OWNER, IDENTITY_ROUTE);
		expect(view.body).toMatchObject({
			pinned: { master_key: before, pinned_by: 'chat' },
			published: { master_key: after }
		});
		// My words from the new identity are acted on all the same
		heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Toujours là ?');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Toujours là ?');
		expect(r.saying('Heard: non')).toHaveLength(0);
	});

	it('takes my yes for a request asked after its question about my identity, the newest', async () => {
		// The identity held: the one I said yes to, not the one I said no to since
		const held = (await r.h.api.get(OWNER, IDENTITY_ROUTE)).body['pinned'];
		const after = await r.client.resetIdentity();
		const asked = r.saying(QUESTION_START).length;
		const requested = r.saying(REQUEST_START).length;
		// My words raise both: the question about my identity first, then the request of their turn
		await r.client.sendText(r.room, 'Cherche le budget dans mes notes');
		expect(await r.nextSaying(QUESTION_START, asked)).toBe(QUESTION);
		await r.nextSaying(REQUEST_START, requested);
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'oui');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/notes/items');
		expect((await r.h.api.get(OWNER, IDENTITY_ROUTE)).body).toMatchObject({
			pinned: held,
			published: { master_key: after }
		});
		// My yes came after the question about my identity too: a yes now answers nothing
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'oui');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: oui');
		expect((await r.h.api.get(OWNER, IDENTITY_ROUTE)).body).toMatchObject({
			pinned: held,
			published: { master_key: after }
		});
	});
});

describe('my assistant asks me about my identity again once its question expired unanswered', () => {
	let r: ConsentRoom;
	beforeAll(async () => {
		// Its questions wait ten seconds for an answer
		r = await startConsentRoom({
			CONSENT_REQUEST_LIFETIME_MS: '10000',
			ADMISSION_USER_PER_MINUTE: '100'
		});
		r.h.apisix.llm.script = modelFor({});
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Hello');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Hello');
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	// The mark of the latest question about my identity
	function lastMark(): Mark {
		return markOf(r, r.saying(EN_QUESTION_START).at(-1)?.eventId ?? '') as Mark;
	}

	it('asks again at my next words from the new identity, valid anew', async () => {
		await r.client.resetIdentity();
		const asked = r.saying(EN_QUESTION_START).length;
		await r.client.sendText(r.room, 'After my reset');
		expect(await r.nextSaying(EN_QUESTION_START, asked)).toBe(EN_QUESTION);
		const first = lastMark();
		await pastExpiry(first);
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Still me');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Still me');
		expect(await r.nextSaying(EN_QUESTION_START, asked + 1)).toBe(EN_QUESTION);
		const second = lastMark();
		expect(second.id).not.toBe(first.id);
		expect(second.expires_ts).toBeGreaterThan(first.expires_ts);
	});

	it('asks no more about an identity once I answered no, even past the end of the question', async () => {
		await r.client.resetIdentity();
		const asked = r.saying(EN_QUESTION_START).length;
		await r.client.sendText(r.room, 'Reset again');
		expect(await r.nextSaying(EN_QUESTION_START, asked)).toBe(EN_QUESTION);
		const question = lastMark();
		const advised = r.saying(EN_REJECTED).length;
		await r.client.sendText(r.room, 'no');
		expect(await r.nextSaying(EN_REJECTED, advised)).toBe(EN_REJECTED);
		await pastExpiry(question);
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Later on');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Later on');
		expect(r.saying(EN_QUESTION_START)).toHaveLength(asked + 1);
	});
});
