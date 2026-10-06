import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
	call,
	modelUsing,
	readCatalog,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';
import { grantConsent, withdrawConsent } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import type { ContractReply } from './helpers/fake-apisix.js';

const DOMAINS = ['mail', 'drive', 'notes', 'tasks', 'photos', 'boards'];
const CONSENT_URL = 'https://agent-consent.test.local/consent';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// What the gateway relays from the platform's token broker when it holds no permission for the
// assistant to act for its owner: an RFC 9457 problem whose code says why, and the link where the
// owner gives that permission
function brokerRefusal(
	code: 'delegation_missing' | 'delegation_expired',
	consentUrl: string = CONSENT_URL
): ContractReply {
	return {
		status: 401,
		body: {
			type: `urn:twake:problem:${code}`,
			title: code === 'delegation_missing' ? 'Delegation missing' : 'Delegation expired',
			status: 401,
			detail: 'The user must open the consent link.',
			code,
			consent_url: consentUrl
		}
	};
}

const RETRY =
	'Once that is done, shall I try again? Answer with the buttons below, or reply yes or no.';
const MISSING = `I need your permission to act on your behalf in your applications, and you have not given it yet. Give it here: ${CONSENT_URL}\n${RETRY}`;
const EXPIRED = `I need your permission to act on your behalf in your applications, and the one you gave me has expired. Give it again here: ${CONSENT_URL}\n${RETRY}`;
const MISSING_WITHOUT_LINK = `I need your permission to act on your behalf in your applications, and you have not given it yet.\n${RETRY}`;
const FRENCH_MISSING = `J'ai besoin de ton autorisation d'agir en ton nom dans tes applications, et tu ne l'as pas encore donnée. Donne-la ici : ${CONSENT_URL}\nUne fois que c'est fait, je réessaie ? Réponds avec les boutons ci-dessous, ou par oui ou non.`;

describe("my assistant sends me the platform's consent link, and tries again once I gave it", () => {
	let r: ConsentRoom;
	// What the platform's broker says of Alice's permission for her assistant to act for her: the
	// gateway relays its refusal for every contract call until she gives it
	let broker: ContractReply | null = null;
	beforeAll(async () => {
		r = await startConsentRoom({ ADMISSION_USER_PER_MINUTE: '100' });
		r.h.apisix.contracts.spec = readCatalog(DOMAINS);
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

	// The harness's requests for that permission, as Alice's client received them
	const ENGLISH_REQUEST = 'I need your permission';
	function requests(prefix: string = ENGLISH_REQUEST): DecryptedMessage[] {
		return r.saying(prefix);
	}

	async function nextRequest(
		seen: number,
		prefix: string = ENGLISH_REQUEST
	): Promise<DecryptedMessage> {
		for (let i = 0; i < 120; i += 1) {
			const latest = requests(prefix).at(seen);
			if (latest !== undefined) return latest;
			await sleep(250);
		}
		throw new Error('no new request from the harness');
	}

	it("sends me the broker's link itself, whatever the model would say, and calls nothing more until I answer", async () => {
		// The model would relay a link of its own, had it read the broker's answer
		r.h.apisix.llm.script = (request) =>
			request.messages.at(-1)?.role === 'tool'
				? { content: 'Open https://phish.example/consent to let me in' }
				: { toolCalls: call('search_mail', { q: 'quarterly-budget' }) };
		const seen = requests().length;
		const modelCalls = r.h.apisix.llm.calls.length;
		await r.client.sendText(r.room, 'Find the budget in my mail');
		const request = await nextRequest(seen);
		expect(request.body).toBe(MISSING);
		// The same two buttons as any question of the harness
		const buttons = await r.client.waitForReactions(r.room, request.eventId, r.assistantId, 2);
		expect(buttons.sort()).toEqual(['✅ YES', '❌ NO']);
		await sleep(1000);
		// The call reached the gateway once, and the model was never asked what to make of it
		expect(r.h.apisix.contracts.calls.map((c) => c.path)).toEqual(['/contracts/v1/mail/items']);
		expect(r.h.apisix.llm.calls).toHaveLength(modelCalls + 1);
		expect(r.client.messages.some((m) => m.body.includes('phish.example'))).toBe(false);
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
	});

	it('tries the frozen call again once I say yes, and carries on with what it found', async () => {
		r.h.apisix.llm.script = modelUsing('search_drive', { q: 'plan' });
		const seen = requests().length;
		const asked = await r.client.sendText(r.room, 'Find my plan in my drive');
		await nextRequest(seen);
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
		let seen = requests().length;
		await r.client.sendText(r.room, 'What are my tasks today?');
		const first = await nextRequest(seen);
		// Alice says yes before she gave her permission
		seen = requests().length;
		await r.client.react(r.room, first.eventId, '✅');
		const second = await nextRequest(seen);
		expect(second.body).toBe(MISSING);
		await sleep(2000);
		expect(r.h.apisix.contracts.calls.map((c) => c.query)).toEqual([
			{ q: 'today' },
			{ q: 'today' }
		]);
		expect(requests()).toHaveLength(seen + 1);
		// Once she gave it, her yes on the new request runs the call
		broker = null;
		const found = r.saying('Found:').length;
		await r.client.react(r.room, second.eventId, '✅ YES');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/tasks/items');
		expect(r.h.apisix.contracts.calls).toHaveLength(3);
	});

	it('tells me when the permission I gave has expired, and drops the call when I say no', async () => {
		broker = brokerRefusal('delegation_expired');
		r.h.apisix.llm.script = modelUsing('search_notes', { q: 'minutes' });
		const seen = requests().length;
		await r.client.sendText(r.room, 'Find the minutes in my notes');
		expect((await nextRequest(seen)).body).toBe(EXPIRED);
		const acknowledged = r.saying('All right').length;
		const modelCalls = r.h.apisix.llm.calls.length;
		await r.client.sendText(r.room, 'No');
		expect(await r.nextSaying('All right', acknowledged)).toBe('All right, I will not do it.');
		expect(r.h.apisix.llm.calls).toHaveLength(modelCalls);
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
	});

	it('never shows me a link of the broker that is not a plain https address', async () => {
		r.h.apisix.llm.script = modelUsing('search_photos', { q: 'party' });
		for (const link of [
			'http://agent-consent.test.local/consent',
			'javascript:alert(1)',
			'https://agent-consent.test.local@phish.example/consent',
			'https://agent-consent.test.local/consent\nhttps://phish.example/consent'
		]) {
			broker = brokerRefusal('delegation_missing', link);
			const seen = requests().length;
			await r.client.sendText(r.room, 'Look for the party in my photos');
			expect((await nextRequest(seen)).body).toBe(MISSING_WITHOUT_LINK);
		}
		expect(r.client.messages.some((m) => m.body.includes('phish.example'))).toBe(false);
	});

	it('asks for my consent again, rather than take my yes for it, when I withdrew it before answering', async () => {
		r.h.apisix.llm.script = modelUsing('search_boards', { q: 'roadmap' });
		const seen = requests().length;
		await r.client.sendText(r.room, 'Show me the roadmap board');
		const request = await nextRequest(seen);
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
		const seen = requests("J'ai besoin").length;
		await r.client.sendText(r.room, 'Cherche la facture dans mes mails');
		const request = await nextRequest(seen, "J'ai besoin");
		expect(request.body).toBe(FRENCH_MISSING);
		const buttons = await r.client.waitForReactions(r.room, request.eventId, r.assistantId, 2);
		expect(buttons.sort()).toEqual(['✅ OUI', '❌ NON']);
		broker = null;
		told = r.saying('Tool:').length;
		await r.client.sendText(r.room, 'oui');
		expect(await r.nextSaying('Tool:', told)).toContain('/contracts/v1/mail/items');
	});
});
