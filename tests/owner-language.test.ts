import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { call, readCatalog, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import type { ChatRequest, ScriptedReply } from './helpers/fake-apisix.js';

const DOMAINS = ['mail', 'drive', 'notes'];

// A literal model: it changes its language, reads an application or fails when its owner says so,
// tells what a tool gave back, and repeats anything else it hears
const READS: Record<string, string> = {
	'Find the budget in my mail': 'search_mail',
	'Cherche le budget dans mes notes': 'search_notes',
	'Cherche mon plan dans mon drive': 'search_drive'
};
const SWITCHES: Record<string, string> = {
	'Parle-moi en français': 'fr',
	'Sprich Deutsch mit mir': 'de'
};

function model(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	const content = last?.content ?? '';
	if (last?.role === 'tool') return { content: `Tool: ${content}` };
	// Both at once: the switch, then the read
	if (content === 'Switch to English and find the budget in my mail') {
		return {
			toolCalls: [
				...call('set_language', { language: 'en' }),
				...call('search_mail', { q: 'budget' })
			]
		};
	}
	const read = READS[content];
	if (read !== undefined) return { toolCalls: call(read, { q: 'budget' }) };
	const language = SWITCHES[content];
	if (language !== undefined) return { toolCalls: call('set_language', { language }) };
	if (content === 'Échoue') return { content: '' };
	return { content: `Heard: ${content}` };
}

const FRENCH_QUESTION =
	"C'est la première fois que j'ai besoin de lire tes données dans notes. Tu m'autorises ? Réponds avec les boutons ci-dessous, ou par oui ou non.";

describe('my assistant speaks my language', () => {
	let r: ConsentRoom;
	beforeAll(async () => {
		r = await startConsentRoom({ ADMISSION_USER_PER_MINUTE: '100' });
		r.h.apisix.contracts.spec = readCatalog(DOMAINS);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(DOMAINS.length);
		r.h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
		r.h.apisix.llm.script = model;
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('speaks French once I ask, and so does the harness', async () => {
		// A new assistant speaks the deployment's language
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Find the budget in my mail');
		await r.nextQuestion(seen);

		let told = r.saying('Tool:').length;
		await r.client.sendText(r.room, 'Parle-moi en français');
		expect(await r.nextSaying('Tool:', told)).toContain('"language":"fr"');

		const asked = r.saying("C'est la première fois").length;
		await r.client.sendText(r.room, 'Cherche le budget dans mes notes');
		expect(await r.nextSaying("C'est la première fois", asked)).toBe(FRENCH_QUESTION);
		// The model is told, in French, to speak French
		const system = r.h.apisix.llm.calls.at(-1)?.request.messages[0]?.content ?? '';
		expect(system).toContain("Parle français avec la personne qui t'écrit.");
		const question = r.saying("C'est la première fois").at(-1)?.eventId ?? '';
		const buttons = await r.client.waitForReactions(r.room, question, r.assistantId, 2);
		expect(buttons.sort()).toEqual(['✅ OUI', '❌ NON']);

		told = r.saying("D'accord").length;
		await r.client.sendText(r.room, 'non');
		expect(await r.nextSaying("D'accord", told)).toBe("D'accord, je ne le fais pas.");
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it('refuses a language it does not speak, and names those it does', async () => {
		const told = r.saying('Tool:').length;
		await r.client.sendText(r.room, 'Sprich Deutsch mit mir');
		const result = await r.nextSaying('Tool:', told);
		expect(result).toContain('unsupported language');
		expect(result).toContain('"en":"English"');
		expect(result).toContain('"fr":"Français"');
	});

	it('keeps my language across a restart, its notices included', async () => {
		const told = r.saying('Tool:').length;
		await r.client.sendText(r.room, 'Parle-moi en français');
		await r.nextSaying('Tool:', told);
		await r.h.restartRole();

		const failed = r.saying('Quelque chose').length;
		await r.client.sendText(r.room, 'Échoue');
		expect(await r.nextSaying('Quelque chose', failed)).toBe(
			"Quelque chose s'est mal passé de mon côté. Réessaie dans un instant."
		);

		const asked = r.saying("C'est la première fois").length;
		await r.client.sendText(r.room, 'Cherche mon plan dans mon drive');
		await r.nextSaying("C'est la première fois", asked);
		const question = r.saying("C'est la première fois").at(-1)?.eventId ?? '';
		const refused = r.saying("D'accord").length;
		await r.client.react(r.room, question, '❌ NON');
		expect(await r.nextSaying("D'accord", refused)).toBe("D'accord, je ne le fais pas.");
	});

	it('asks in the language I switched to earlier in the same message', async () => {
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Switch to English and find the budget in my mail');
		const question = await r.nextQuestion(seen);
		expect(r.questions().at(-1)?.body).toBe(
			'This is the first time I need to read your data in mail. Do you allow it? Answer with the buttons below, or reply yes or no.'
		);
		const buttons = await r.client.waitForReactions(r.room, question, r.assistantId, 2);
		expect(buttons.sort()).toEqual(['✅ YES', '❌ NO']);
	});

	it("leaves everyone else in the deployment's language", async () => {
		const res = await r.h.api.post<{ answer: string }>('bob@test.local', '/v1/chat', {
			message: 'Find the budget in my mail'
		});
		expect(res.body.answer).toBe(
			'This is the first time I need to read your data in mail. Do you allow it? Answer with the buttons below, or reply yes or no.'
		);
	});
});
