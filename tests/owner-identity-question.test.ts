import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeSettableClock } from './helpers/clock.js';
import {
	modelFor,
	modelUsing,
	QUESTION_CONTENT_KEY,
	readCatalog,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';

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
const DENIED_START = "Tu m'as dit ne pas avoir réinitialisé";
const DENIED =
	"Tu m'as dit ne pas avoir réinitialisé ton identité de chiffrement : je continue de signaler ce que tu écris avec la nouvelle, et j'y donne suite pour l'instant. Si tu l'as bien réinitialisée, réponds oui quand je te reposerai la question, une fois qu'elle aura expiré.";
const OLD_SESSION_START = "Je n'ai pas donné suite à ton dernier message : ton application";
const OLD_SESSION =
	"Je n'ai pas donné suite à ton dernier message : ton application l'a chiffré avec des clés qu'elle utilise depuis plus de trente jours, que je n'accepte plus. Envoie /discardsession dans ce salon pour qu'elle en utilise de nouvelles ; puis renvoie-le.";
const CHANGED_REFUSAL_START = "Je n'ai pas donné suite à ton dernier message : ton identité";
const CHANGED_REFUSAL =
	"Je n'ai pas donné suite à ton dernier message : ton identité de chiffrement a changé, et je ne donne suite qu'à celle que je connais. Si tu l'as réinitialisée toi-même, confirme la nouvelle par l'API de ton assistant (PUT /v1/assistants/me/owner-identity) : par sécurité, aucun message ne le peut. Sinon, change ton mot de passe et préviens ton administrateur. D'ici là, je ne donne suite à aucun de tes messages.";
// What a request about a first call to an application starts with, in French
const REQUEST_START = "C'est la première fois";
// What my assistant tells me in French when my limit for the day kept it from doing what I allowed,
// asking me again about my request
const OPEN_UNTIL_MIDNIGHT_START = "J'ai atteint ma limite du jour";
const OPEN_UNTIL_MIDNIGHT =
	"J'ai atteint ma limite du jour, je ne l'ai donc pas encore fait, et ta demande reste ouverte.\nUne fois minuit passé, quand ma limite se lève, je le fais ? Réponds par oui ou non dans ton prochain message.";

const EN_QUESTION =
	'Your encryption identity is not the one I know. Did you reset your identity yourself? Answer yes or no in your next message.';
const EN_QUESTION_START = 'Your encryption identity is not the one I know. Did you';
const EN_REJECTED =
	'Then someone else may have reset it: change your password now and warn your administrator. I keep the identity I knew, and I go on answering you as before.';
const EN_ADOPTED =
	'Noted: your new identity is now the one I know, and I no longer flag your messages.';

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
	const sessions: E2eeClient[] = [];
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
		for (const session of sessions) await session.stop();
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
		const held = {
			pinned: { master_key: after, pinned_by: 'chat', pinned_at: expect.any(String) },
			published: null
		};
		expect((await r.h.api.get(OWNER, IDENTITY_ROUTE)).body).toEqual(held);
		// My words from it get their answer alone: a notice or a question about them would reach the
		// room before it, and none does; nor do they set my identity aside again
		const said = r.client.messages.filter((m) => m.sender === r.assistantId).length;
		heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Merci');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Merci');
		expect(r.client.messages.filter((m) => m.sender === r.assistantId)).toHaveLength(said + 1);
		expect((await r.h.api.get(OWNER, IDENTITY_ROUTE)).body).toEqual(held);
		// My yes was an answer: it started no turn of its own
		expect(r.saying('Heard: oui')).toHaveLength(0);
	});

	it('keeps the identity it knew when I answer no, tells me what to do, and still flags my words from the new one', async () => {
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
		// My words from the new identity are acted on all the same, and I am told it still flags
		// them, with nothing to answer while its question lasts
		const denied = r.saying(DENIED_START).length;
		heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Toujours là ?');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Toujours là ?');
		expect(await r.nextSaying(DENIED_START, denied)).toBe(DENIED);
		expect(markOf(r, r.saying(DENIED_START).at(-1)?.eventId ?? '')).toBeUndefined();
		expect(r.saying(QUESTION_START)).toHaveLength(asked + 1);
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

	it('takes my yes for no confirmation once the deployment enforces, until I confirm my identity through the API', async () => {
		// Another session of mine replaces my identity with a new one that signs it alone, and I
		// answer yes from it when my assistant asks me about it
		const other = await startE2eeClient(r.h.synapse.url, await r.h.synapse.login('alice'));
		sessions.push(other);
		const after = await other.resetIdentity();
		const asked = r.saying(QUESTION_START).length;
		let heard = r.saying('Heard:').length;
		await other.sendText(r.room, 'Depuis ma nouvelle session');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Depuis ma nouvelle session');
		expect(await r.nextSaying(QUESTION_START, asked)).toBe(QUESTION);
		const adopted = r.saying(ADOPTED).length;
		await other.sendText(r.room, 'oui');
		expect(await r.nextSaying(ADOPTED, adopted)).toBe(ADOPTED);
		// The deployment now enforces, where no message confirms an identity: my words from it are
		// not acted on, and the API shows it as one for me to confirm
		await r.h.restartRole({ env: { OWNER_DEVICE_TRUST: 'enforce' } });
		const refused = r.saying(CHANGED_REFUSAL_START).length;
		await other.sendText(r.room, 'Encore moi');
		expect(await r.nextSaying(CHANGED_REFUSAL_START, refused)).toBe(CHANGED_REFUSAL);
		expect((await r.h.api.get(OWNER, IDENTITY_ROUTE)).body).toMatchObject({
			pinned: { master_key: after, pinned_by: 'chat' },
			published: { master_key: after }
		});
		// Once I confirm it through the API, my words from it are acted on again
		const confirmed = await r.h.api.put(OWNER, IDENTITY_ROUTE, { master_key: after });
		expect(confirmed.status).toBe(200);
		expect(confirmed.body).toEqual({
			pinned: { master_key: after, pinned_by: 'api', pinned_at: expect.any(String) },
			published: null
		});
		heard = r.saying('Heard:').length;
		await other.sendText(r.room, 'Et maintenant ?');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Et maintenant ?');
		expect(r.saying('Heard: Encore moi')).toHaveLength(0);
	});
});

describe('my assistant asks me again about a request after asking about my identity, my limit for the day reached in Europe/Paris', () => {
	// 23:30 in Paris
	const clock = makeSettableClock('2026-10-08T21:30:00Z');
	let r: ConsentRoom;
	beforeAll(async () => {
		// A day of one turn, and no wait between my turns
		r = await startConsentRoom(
			{
				ASSISTANT_LOCALE: 'fr',
				ASSISTANT_TIMEZONE: 'Europe/Paris',
				ADMISSION_USER_DAILY_TOKENS: '1',
				ADMISSION_USER_PER_MINUTE: '100'
			},
			{ clock }
		);
		r.h.apisix.contracts.spec = readCatalog(['mail']);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(1);
		r.h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
		r.h.apisix.llm.script = modelUsing('search_mail', { q: 'budget' });
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('takes my next yes for that request, the newest question of my room, after midnight', async () => {
		// My first words hold the identity I have now, and their turn asks me before it reads my mail,
		// which spends my day
		const before = await r.client.masterKey();
		await r.client.sendText(r.room, 'Trouve le budget dans mes mails');
		await r.nextSaying(REQUEST_START, 0);
		const request = r.saying(REQUEST_START).at(0)?.eventId ?? '';
		// My yes comes from an identity I reset: my assistant asks me about it, then asks me again
		// about my request, which my limit kept it from doing
		const after = await r.client.resetIdentity();
		await r.client.sendText(r.room, 'oui');
		expect(await r.nextSaying(QUESTION_START, 0)).toBe(QUESTION);
		expect(await r.nextSaying(OPEN_UNTIL_MIDNIGHT_START, 0)).toBe(OPEN_UNTIL_MIDNIGHT);
		const question = r.saying(QUESTION_START).at(0)?.eventId ?? '';
		const notice = r.saying(OPEN_UNTIL_MIDNIGHT_START).at(0)?.eventId ?? '';
		expect(markOf(r, notice)).toEqual(markOf(r, request));
		const order = r.client.messages.map((m) => m.eventId);
		expect(order.indexOf(question)).toBeLessThan(order.indexOf(notice));
		// After midnight, my yes does what I asked, and leaves my identity as it was
		clock.set('2026-10-08T22:05:00Z');
		await r.client.sendText(r.room, 'oui');
		expect(await r.nextSaying('Found:', 0)).toContain('/contracts/v1/mail/items');
		expect((await r.h.api.get(OWNER, IDENTITY_ROUTE)).body).toMatchObject({
			pinned: { master_key: before, pinned_by: 'first_use' },
			published: { master_key: after }
		});
		expect(r.saying(ADOPTED)).toHaveLength(0);
	});
});

describe('my assistant tells me in my language to discard a session it first saw over a month ago', () => {
	// The present as the harness reads it, which the test moves on by a month
	const clock = makeSettableClock('2026-10-08T09:00:00Z');
	let r: ConsentRoom;
	beforeAll(async () => {
		r = await startConsentRoom(
			{ ASSISTANT_LOCALE: 'fr', ADMISSION_USER_PER_MINUTE: '100' },
			{ clock }
		);
		r.h.apisix.llm.script = modelFor({});
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('takes no words of it, and tells me to send /discardsession in this room, then send again', async () => {
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Mots récents');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Mots récents');
		// A month and a day later, my app still encrypts with the keys of that session
		clock.set('2026-11-09T09:00:00Z');
		const notices = r.saying(OLD_SESSION_START).length;
		await r.client.sendText(r.room, "Mots d'une vieille session");
		expect(await r.nextSaying(OLD_SESSION_START, notices)).toBe(OLD_SESSION);
		expect(r.saying("Heard: Mots d'une vieille session")).toHaveLength(0);
	});
});

describe('my assistant asks me about my identity again once its question expired', () => {
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

	it('asks again once its question expired after I answered no, and holds the identity at my yes', async () => {
		const after = await r.client.resetIdentity();
		const asked = r.saying(EN_QUESTION_START).length;
		await r.client.sendText(r.room, 'Reset again');
		expect(await r.nextSaying(EN_QUESTION_START, asked)).toBe(EN_QUESTION);
		const question = lastMark();
		const advised = r.saying(EN_REJECTED).length;
		await r.client.sendText(r.room, 'no');
		expect(await r.nextSaying(EN_REJECTED, advised)).toBe(EN_REJECTED);
		// A no given by mistake is taken back at the next question, once this one expired
		await pastExpiry(question);
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Later on');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Later on');
		expect(await r.nextSaying(EN_QUESTION_START, asked + 1)).toBe(EN_QUESTION);
		expect(lastMark().id).not.toBe(question.id);
		const adopted = r.saying(EN_ADOPTED).length;
		await r.client.sendText(r.room, 'yes');
		expect(await r.nextSaying(EN_ADOPTED, adopted)).toBe(EN_ADOPTED);
		expect((await r.h.api.get(OWNER, IDENTITY_ROUTE)).body).toEqual({
			pinned: { master_key: after, pinned_by: 'chat', pinned_at: expect.any(String) },
			published: null
		});
	});
});
