import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import {
	call,
	modelUsing,
	QUESTION_CONTENT_KEY,
	readCatalog,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';
import { grantConsent, withdrawConsent } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import { BROKER_CONSENT_URL, brokerRefusal, type ContractReply } from './helpers/fake-apisix.js';

const DOMAINS = ['mail', 'drive', 'notes', 'tasks', 'photos', 'boards', 'sheets'];
// The deployment's consent link bound to Alice, the owner it is for, as the broker expects it
const ALICE_CONSENT_URL = `${BROKER_CONSENT_URL}?owner=alice%40test.local`;
// A link of its own that a contract, or anything else answering a call, could put in a refusal
const FAKED_LINK = 'https://phish.example/consent';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The request about a read in an application, named as a first use names it
const ANSWER = 'Answer yes or no in your next message.';
const NEEDED = (application: string): string =>
	`To read your data in ${application}, I need your permission to act on your behalf`;
const MISSING = (application: string): string =>
	`${NEEDED(application)}, and you have not given it yet. Give it here: ${ALICE_CONSENT_URL}\nOnce that is done, shall I try again? ${ANSWER}`;
const EXPIRED = (application: string): string =>
	`${NEEDED(application)}, and the one you gave me has expired. Give it again here: ${ALICE_CONSENT_URL}\nOnce that is done, shall I try again? ${ANSWER}`;
const MISSING_WITHOUT_LINK = `${NEEDED('mail')}, and you have not given it yet.\nShall I try again? ${ANSWER}`;
const EXPIRED_WITHOUT_LINK = `${NEEDED('mail')}, and the one you gave me has expired.\nShall I try again? ${ANSWER}`;
const FRENCH_MISSING = `Pour lire tes données dans Twake Mail, j'ai besoin de ton autorisation d'agir en ton nom, et tu ne l'as pas encore donnée. Donne-la ici : ${ALICE_CONSENT_URL}\nUne fois que c'est fait, je réessaie ? Réponds par oui ou non dans ton prochain message.`;

// The harness's requests for that permission, as Alice's client received them
const ENGLISH_REQUEST = 'To read your data in';

function requestsIn(r: ConsentRoom, prefix: string = ENGLISH_REQUEST): DecryptedMessage[] {
	return r.saying(prefix);
}

async function nextRequestIn(
	r: ConsentRoom,
	seen: number,
	prefix: string = ENGLISH_REQUEST
): Promise<DecryptedMessage> {
	for (let i = 0; i < 120; i += 1) {
		const latest = requestsIn(r, prefix).at(seen);
		if (latest !== undefined) return latest;
		await sleep(250);
	}
	throw new Error('no new request from the harness');
}

// The calls that waited for that permission in an application, summed over the api replicas'
// metrics as an operator's dashboard reads them
async function delegationRequests(r: ConsentRoom, domain: string): Promise<number> {
	const sample = new RegExp(
		`^harness_consent_requests_total\\{domain="${domain}",level="read",reason="delegation"\\} (\\d+)$`,
		'm'
	);
	let sum = 0;
	for (const app of r.h.apps) {
		const text = (await app.inject({ method: 'GET', url: '/metrics' })).body;
		sum += Number(sample.exec(text)?.[1] ?? 0);
	}
	return sum;
}

// Everything Alice's client can show of a message: its text, and its rendering with the links
function shown(message: DecryptedMessage): string {
	const formatted = message.content['formatted_body'];
	return `${message.body}\n${typeof formatted === 'string' ? formatted : ''}`;
}

describe("the token broker's consent link setting", () => {
	const base = {
		HARNESS_ROLE: 'api',
		DATABASE_URL: 'postgres://x@localhost/x',
		AUTH_JWKS_URL: 'https://example.test/jwks',
		AUTH_ISSUER: 'https://example.test/',
		AUTH_AUDIENCE: 'twake-harness',
		APISIX_BASE_URL: 'http://apisix.test',
		APISIX_CONSUMER_KEY: 'k'
	};

	it('refuses, at startup, a link that is not an https URL', () => {
		for (const link of [
			'http://agent-consent.test.local/consent',
			'agent-consent.test.local/consent',
			'javascript:alert(1)'
		]) {
			expect(() => loadConfig({ ...base, BROKER_CONSENT_URL: link })).toThrow(
				`invalid configuration: BROKER_CONSENT_URL ${JSON.stringify(link)} is not an https URL`
			);
		}
	});

	it('keeps the https link it is given, and none when it is given none', () => {
		expect(loadConfig({ ...base, BROKER_CONSENT_URL }).consent.brokerConsentUrl).toBe(
			BROKER_CONSENT_URL
		);
		expect(loadConfig(base).consent.brokerConsentUrl).toBeNull();
	});
});

describe("my assistant sends me the platform's consent link, and tries again once I gave it", () => {
	let r: ConsentRoom;
	// What the platform's broker says of Alice's permission for her assistant to act for her: the
	// gateway relays its refusal for every contract call until she gives it
	let broker: ContractReply | null = null;
	beforeAll(async () => {
		r = await startConsentRoom({ ADMISSION_USER_PER_MINUTE: '100', BROKER_CONSENT_URL });
		// The catalog names one application to the owners; the others go by their ids
		r.h.apisix.contracts.spec = {
			...readCatalog(DOMAINS),
			'x-twake-domains': { mail: { name: { en: 'Twake Mail', fr: 'Twake Mail' } } }
		};
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(DOMAINS.length);
		// Alice let her assistant read these applications: what is missing here is the platform's
		// own permission
		for (const domain of DOMAINS) await grantConsent(r.h.db, 'alice@test.local', domain, 'read');
		r.h.apisix.contracts.handler = (c) => broker ?? { status: 200, body: { found: c.path } };
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});
	beforeEach(() => {
		r.h.apisix.contracts.calls.length = 0;
		broker = brokerRefusal('delegation_missing');
	});

	it("sends me the platform's consent link itself, whatever the model would say, and calls nothing more until I answer", async () => {
		// The model would relay a link of its own, had it read the broker's answer
		r.h.apisix.llm.script = (request) =>
			request.messages.at(-1)?.role === 'tool'
				? { content: `Open ${FAKED_LINK} to let me in` }
				: { toolCalls: call('search_mail', { q: 'quarterly-budget' }) };
		const seen = requestsIn(r).length;
		const modelCalls = r.h.apisix.llm.calls.length;
		await r.client.sendText(r.room, 'Find the budget in my mail');
		const request = await nextRequestIn(r, seen);
		expect(request.body).toBe(MISSING('Twake Mail'));
		await sleep(1000);
		// The call reached the gateway once, and the model was never asked what to make of it
		expect(r.h.apisix.contracts.calls.map((c) => c.path)).toEqual(['/contracts/v1/mail/items']);
		expect(r.h.apisix.llm.calls).toHaveLength(modelCalls + 1);
		expect(r.client.messages.some((m) => shown(m).includes('phish.example'))).toBe(false);
		// The wait is logged with why, never with what the call would send
		const waits = r.h.logLines().filter((l) => l['msg'] === 'contract call waits for its owner');
		expect(waits.at(-1)).toMatchObject({
			tool: 'search_mail',
			domain: 'mail',
			level: 'read',
			reasons: ['delegation'],
			principal: 'alice@test.local'
		});
		expect(r.h.logLines().some((l) => JSON.stringify(l).includes('quarterly-budget'))).toBe(false);
		expect(await delegationRequests(r, 'mail')).toBe(1);
	});

	it('tries the frozen call again once I say yes, and carries on with what it found', async () => {
		r.h.apisix.llm.script = modelUsing('search_drive', { q: 'plan' });
		const seen = requestsIn(r).length;
		const asked = await r.client.sendText(r.room, 'Find my plan in my drive');
		await nextRequestIn(r, seen);
		// Alice gives the platform her permission, then tells her assistant
		broker = null;
		const found = r.saying('Found:').length;
		const modelCalls = r.h.apisix.llm.calls.length;
		await r.client.sendText(r.room, 'yes');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/drive/items');
		// The same call, refused then tried again, both under the id of the message that asked for it
		expect(r.h.apisix.contracts.calls.map((c) => c.query)).toEqual([{ q: 'plan' }, { q: 'plan' }]);
		expect(r.h.apisix.contracts.calls.map((c) => c.headers['x-correlation-id'])).toEqual([
			asked,
			asked
		]);
		// The model goes on knowing that the call waited for that permission
		const history = r.h.apisix.llm.calls[modelCalls]?.request.messages ?? [];
		const waited = history.find((m) => m.role === 'tool' && m.tool_call_id === 'call_search_drive');
		expect(JSON.parse(waited?.content ?? '{}')).toEqual({
			status: 'awaiting_owner',
			reason: 'delegation',
			code: 'delegation_missing'
		});
	});

	it('asks me again when the platform still refuses after my yes, trying the call once per yes', async () => {
		r.h.apisix.llm.script = modelUsing('search_tasks', { q: 'today' });
		let seen = requestsIn(r).length;
		await r.client.sendText(r.room, 'What are my tasks today?');
		const first = await nextRequestIn(r, seen);
		// Alice says yes before she gave her permission
		seen = requestsIn(r).length;
		await r.client.react(r.room, first.eventId, '✅');
		const second = await nextRequestIn(r, seen);
		expect(second.body).toBe(MISSING('tasks'));
		await sleep(2000);
		expect(r.h.apisix.contracts.calls.map((c) => c.query)).toEqual([
			{ q: 'today' },
			{ q: 'today' }
		]);
		expect(requestsIn(r)).toHaveLength(seen + 1);
		expect(await delegationRequests(r, 'tasks')).toBe(2);
		// Once she gave it, her yes on the new request runs the call
		broker = null;
		const found = r.saying('Found:').length;
		await r.client.react(r.room, second.eventId, '✅');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/tasks/items');
		expect(r.h.apisix.contracts.calls).toHaveLength(3);
	});

	it('tells me when the permission I gave has expired, and drops the call when I say no', async () => {
		broker = brokerRefusal('delegation_expired');
		r.h.apisix.llm.script = modelUsing('search_notes', { q: 'minutes' });
		const seen = requestsIn(r).length;
		await r.client.sendText(r.room, 'Find the minutes in my notes');
		const request = await nextRequestIn(r, seen);
		expect(request.body).toBe(EXPIRED('notes'));
		await r.requestAskedIn(request.eventId, 'notes');
		const acknowledged = r.saying('All right').length;
		const modelCalls = r.h.apisix.llm.calls.length;
		await r.client.sendText(r.room, 'No');
		expect(await r.nextSaying('All right', acknowledged)).toBe('All right, I will not do it.');
		expect(r.h.apisix.llm.calls).toHaveLength(modelCalls);
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
	});

	it("shows me the platform's own consent link, never the one a refusal carries", async () => {
		broker = brokerRefusal('delegation_missing', FAKED_LINK);
		r.h.apisix.llm.script = modelUsing('search_photos', { q: 'party' });
		const seen = requestsIn(r).length;
		await r.client.sendText(r.room, 'Look for the party in my photos');
		const request = await nextRequestIn(r, seen);
		expect(request.body).toBe(MISSING('photos'));
		expect(request.content['formatted_body']).toContain(`href="${ALICE_CONSENT_URL}"`);
		expect(shown(request)).not.toContain('phish.example');
	});

	it('asks for my consent again, rather than take my yes for it, when I withdrew it before answering', async () => {
		r.h.apisix.llm.script = modelUsing('search_boards', { q: 'roadmap' });
		const seen = requestsIn(r).length;
		await r.client.sendText(r.room, 'Show me the roadmap board');
		const request = await nextRequestIn(r, seen);
		// Before she answers, Alice takes back her assistant's reading of her boards, then gives the
		// platform its permission and says yes
		await withdrawConsent(r.h.db, 'alice@test.local', 'boards', 'read');
		broker = null;
		const questions = r.questions().length;
		await r.client.react(r.room, request.eventId, '✅');
		const question = await r.nextQuestion(questions);
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
		// Her yes to that question lets her assistant read her boards again, and runs the call
		const found = r.saying('Found:').length;
		await r.client.react(r.room, question, '✅');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/boards/items');
		expect(r.h.apisix.contracts.calls.map((c) => c.query)).toEqual([
			{ q: 'roadmap' },
			{ q: 'roadmap' }
		]);
	});

	it('tells my client which request each question to try again is and until when, in words left unchanged', async () => {
		r.h.apisix.llm.script = modelUsing('search_sheets', { q: 'budget' });
		let seen = requestsIn(r).length;
		await r.client.sendText(r.room, 'Find the budget in my sheets');
		const first = await nextRequestIn(r, seen);
		expect(first.body).toBe(MISSING('sheets'));
		const asked = await r.requestAskedIn(first.eventId, 'sheets');
		// I say yes before I gave the platform my permission: it asks me again, under a request of
		// its own
		seen = requestsIn(r).length;
		await r.client.sendText(r.room, 'yes');
		const second = await nextRequestIn(r, seen);
		expect(second.body).toBe(MISSING('sheets'));
		expect((await r.requestAskedIn(second.eventId, 'sheets')).id).not.toBe(asked.id);
		// My no in words answers it as before, and the notice that tells me so asks nothing
		const acknowledged = r.saying('All right').length;
		await r.client.sendText(r.room, 'non');
		expect(await r.nextSaying('All right', acknowledged)).toBe('All right, I will not do it.');
		expect(r.saying('All right').at(acknowledged)?.content).not.toHaveProperty([
			QUESTION_CONTENT_KEY
		]);
		expect(r.h.apisix.contracts.calls).toHaveLength(2);
	});

	it('asks me in my own language', async () => {
		r.h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool') return { content: `Tool: ${last.content ?? ''}` };
			return last?.content === 'Parle-moi en français'
				? { toolCalls: call('set_language', { language: 'fr' }) }
				: { toolCalls: call('search_mail', { q: 'facture' }) };
		};
		let told = r.saying('Tool:').length;
		await r.client.sendText(r.room, 'Parle-moi en français');
		expect(await r.nextSaying('Tool:', told)).toContain('"language":"fr"');
		const seen = requestsIn(r, 'Pour lire tes données dans').length;
		await r.client.sendText(r.room, 'Cherche la facture dans mes mails');
		const request = await nextRequestIn(r, seen, 'Pour lire tes données dans');
		expect(request.body).toBe(FRENCH_MISSING);
		broker = null;
		told = r.saying('Tool:').length;
		await r.client.sendText(r.room, 'oui');
		expect(await r.nextSaying('Tool:', told)).toContain('/contracts/v1/mail/items');
	});
});

describe('my assistant tells me why it cannot act for me, even when the deployment gives no consent link', () => {
	let r: ConsentRoom;
	let broker: ContractReply | null = null;
	beforeAll(async () => {
		// No BROKER_CONSENT_URL: the deployment gives no link to show
		r = await startConsentRoom({ ADMISSION_USER_PER_MINUTE: '100' });
		r.h.apisix.contracts.spec = readCatalog(['mail']);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(1);
		await grantConsent(r.h.db, 'alice@test.local', 'mail', 'read');
		r.h.apisix.contracts.handler = (c) => broker ?? { status: 200, body: { found: c.path } };
		r.h.apisix.llm.script = modelUsing('search_mail', { q: 'budget' });
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('says why, shows no link, promises no step I could not take, and still tries again on my yes', async () => {
		const asked: string[] = [];
		for (const [code, expected] of [
			['delegation_missing', MISSING_WITHOUT_LINK],
			['delegation_expired', EXPIRED_WITHOUT_LINK]
		] as const) {
			broker = brokerRefusal(code, FAKED_LINK);
			const seen = requestsIn(r).length;
			await r.client.sendText(r.room, 'Find the budget in my mail');
			const request = await nextRequestIn(r, seen);
			expect(request.body).toBe(expected);
			expect(shown(request)).not.toContain('http');
			asked.push((await r.requestAskedIn(request.eventId, 'mail')).id);
		}
		// Each question names a request of its own
		expect(new Set(asked).size).toBe(2);
		// Alice gave her permission another way, and says yes
		broker = null;
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'yes');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/mail/items');
	});
});
