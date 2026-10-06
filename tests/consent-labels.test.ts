import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { call, readCatalog, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import type { ChatRequest, ScriptedReply } from './helpers/fake-apisix.js';

const APPLICATIONS = ['mail', 'drive', 'photos', 'tasks', 'notes'];

// How the contracts service names its applications to their owners. Mail is named apart in each
// language, to tell which one the owner reads; Drive is described in English only, Photos by its
// name alone, and Tasks and Notes not at all.
const DESCRIBED = {
	mail: {
		name: { en: 'Twake Mail', fr: 'Messagerie Twake' },
		read: { en: 'list, search and read your mail', fr: 'lister, chercher et lire tes mails' },
		write: {
			en: 'move, archive and delete your mail',
			fr: 'déplacer, archiver et supprimer tes mails'
		}
	},
	drive: {
		name: { en: 'Twake Drive' },
		read: { en: 'browse and read your files' }
	},
	photos: { name: { en: 'Twake Photos', fr: 'Twake Photos' } }
};

const TASKS = {
	name: { en: 'Twake Tasks', fr: 'Tâches Twake' },
	read: { en: 'list and read your tasks and boards', fr: 'lister et lire tes tâches et tableaux' }
};

// A literal model: it reads the application its owner names, changes its language when asked, and
// repeats anything else it hears
const READS: Record<string, string> = {
	'Find the budget in my mail': 'search_mail',
	'Show my photos': 'search_photos',
	'Show my tasks': 'search_tasks',
	'Search my notes': 'search_notes',
	'Cherche le budget dans mes mails': 'search_mail',
	'Cherche le plan dans mon drive': 'search_drive'
};

function model(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	const content = last?.content ?? '';
	if (last?.role === 'tool') return { content: `Tool: ${content}` };
	if (content === 'Parle-moi en français') {
		return { toolCalls: call('set_language', { language: 'fr' }) };
	}
	const read = READS[content];
	if (read !== undefined) return { toolCalls: call(read, { q: 'budget' }) };
	return { content: `Heard: ${content}` };
}

// How the question ends, in each language
const HOW_TO_ANSWER = {
	en: 'Do you allow it? Answer with the buttons below, or reply yes or no.',
	fr: "Tu m'autorises ? Réponds avec les boutons ci-dessous, ou par oui ou non."
};

describe('the question names the application in plain words', () => {
	let r: ConsentRoom;

	// The gateway serves this catalog, and every replica of the api role refreshes its own
	async function serve(domains: unknown): Promise<void> {
		r.h.apisix.contracts.spec = { ...readCatalog(APPLICATIONS), 'x-twake-domains': domains };
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(APPLICATIONS.length);
	}

	// What the harness asks after Alice's message, as her client shows it
	async function askedAfter(message: string): Promise<string> {
		const seen = r.questions().length;
		await r.client.sendText(r.room, message);
		await r.nextQuestion(seen);
		return r.questions().at(-1)?.body ?? '';
	}

	// What the harness asks Bob, who talks to the API in the deployment's language
	async function askedThroughApi(message: string): Promise<string> {
		const res = await r.h.api.post<{ answer: string }>('bob@test.local', '/v1/chat', { message });
		expect(res.status).toBe(200);
		return res.body.answer;
	}

	beforeAll(async () => {
		r = await startConsentRoom({ ADMISSION_USER_PER_MINUTE: '100' });
		r.h.apisix.llm.script = model;
		await serve(DESCRIBED);
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});
	beforeEach(() => {
		r.h.apisix.contracts.calls.length = 0;
	});

	it('names the application and says what reading covers there', async () => {
		expect(await askedAfter('Find the budget in my mail')).toBe(
			[
				'This is the first time I need to read your data in Twake Mail.',
				'Reading: list, search and read your mail',
				HOW_TO_ANSWER.en
			].join('\n')
		);
		// An application the catalog names without saying what reading covers there
		expect(await askedAfter('Show my photos')).toBe(
			`This is the first time I need to read your data in Twake Photos. ${HOW_TO_ANSWER.en}`
		);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it('names an application the catalog does not describe by its id', async () => {
		expect(await askedAfter('Search my notes')).toBe(
			`This is the first time I need to read your data in notes. ${HOW_TO_ANSWER.en}`
		);
	});

	it('takes up the words a refresh of the catalog brings, without a restart', async () => {
		expect(await askedAfter('Show my tasks')).toBe(
			`This is the first time I need to read your data in tasks. ${HOW_TO_ANSWER.en}`
		);
		await serve({ ...DESCRIBED, tasks: TASKS });
		const described = [
			'This is the first time I need to read your data in Twake Tasks.',
			'Reading: list and read your tasks and boards',
			HOW_TO_ANSWER.en
		].join('\n');
		expect(await askedAfter('Show my tasks')).toBe(described);
		// A refresh that fails keeps the catalog as it was, its words included
		r.h.apisix.contracts.spec = null;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(APPLICATIONS.length);
		expect(await askedAfter('Show my tasks')).toBe(described);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it('ignores a description of another shape with a warning, and loads the rest', async () => {
		await serve({
			...DESCRIBED,
			photos: { name: { en: 'Twake Pictures' } },
			notes: { name: { en: 'Twake\nNotes' } },
			tasks: { name: 'Twake Tasks', read: TASKS.read }
		});
		const ignored = r.h
			.logLines()
			.filter((line) => line['msg'] === 'domain description ignored, named by its id');
		expect(ignored.map((line) => line['domain'])).toEqual(
			expect.arrayContaining(['notes', 'tasks'])
		);
		expect(ignored.every((line) => line['level'] === 40)).toBe(true);
		expect(await askedThroughApi('Search my notes')).toBe(
			`This is the first time I need to read your data in notes. ${HOW_TO_ANSWER.en}`
		);
		expect(await askedThroughApi('Show my tasks')).toBe(
			`This is the first time I need to read your data in tasks. ${HOW_TO_ANSWER.en}`
		);
		// The rest of this catalog holds, a new name included
		expect(await askedThroughApi('Show my photos')).toBe(
			`This is the first time I need to read your data in Twake Pictures. ${HOW_TO_ANSWER.en}`
		);
		// Descriptions that are no map of domains are ignored whole
		await serve(['mail']);
		expect(
			r.h
				.logLines()
				.some(
					(line) =>
						line['msg'] === 'domain description ignored, named by its id' && line['domain'] === null
				)
		).toBe(true);
		expect(await askedThroughApi('Find the budget in my mail')).toBe(
			`This is the first time I need to read your data in mail. ${HOW_TO_ANSWER.en}`
		);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it('asks in my language, with no word of another', async () => {
		await serve(DESCRIBED);
		const told = r.saying('Tool:').length;
		await r.client.sendText(r.room, 'Parle-moi en français');
		expect(await r.nextSaying('Tool:', told)).toContain('"language":"fr"');

		let asked = r.saying("C'est la première fois").length;
		await r.client.sendText(r.room, 'Cherche le budget dans mes mails');
		expect(await r.nextSaying("C'est la première fois", asked)).toBe(
			[
				"C'est la première fois que j'ai besoin de lire tes données dans Messagerie Twake.",
				'Lecture : lister, chercher et lire tes mails',
				HOW_TO_ANSWER.fr
			].join('\n')
		);
		// Drive is described in English only: a French question names it by its id
		asked = r.saying("C'est la première fois").length;
		await r.client.sendText(r.room, 'Cherche le plan dans mon drive');
		expect(await r.nextSaying("C'est la première fois", asked)).toBe(
			`C'est la première fois que j'ai besoin de lire tes données dans drive. ${HOW_TO_ANSWER.fr}`
		);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});
});
