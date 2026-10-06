import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { call, readCatalog, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import type { ChatRequest, ScriptedReply } from './helpers/fake-apisix.js';

const APPLICATIONS = ['mail', 'drive', 'photos', 'tasks', 'notes', 'wiki', 'boards'];

// One read contract per application, and one write in Mail
const READS_CATALOG = readCatalog(APPLICATIONS) as { paths: Record<string, unknown> };
const CATALOG = {
	...READS_CATALOG,
	paths: {
		...READS_CATALOG.paths,
		'/contracts/v1/mail/items/{item_id}/archive': {
			post: {
				operationId: 'archive_mail',
				summary: "Archives one of the user's mails",
				tags: ['mail.item.archive.v1'],
				'x-twake-risk': 'low',
				parameters: [{ name: 'item_id', in: 'path', required: true, schema: { type: 'string' } }]
			}
		}
	}
};
const CONTRACTS = APPLICATIONS.length + 1;

// How the contracts service names its applications to their owners. Mail is named apart in each
// language, to tell which one the owner reads; Drive is described in English only, the
// deployment's language, and Wiki in French only; Photos by its name alone, and Tasks and Notes
// not at all.
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
	wiki: { name: { fr: 'Wiki Twake' } },
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
	'Find the plan in my drive': 'search_drive',
	'Open my wiki': 'search_wiki',
	'Show my boards': 'search_boards',
	'Cherche le budget dans mes mails': 'search_mail',
	'Cherche le plan dans mon drive': 'search_drive',
	'Ouvre mon wiki': 'search_wiki'
};
const WRITES: Record<string, string> = {
	'Archive the newsletter': 'archive_mail',
	"Archive la lettre d'information": 'archive_mail'
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
	const write = WRITES[content];
	if (write !== undefined) return { toolCalls: call(write, { item_id: 'newsletter-42' }) };
	return { content: `Heard: ${content}` };
}

// How the question ends, above the call it shows, and how to answer, under the call, in each
// language
const ALLOW = {
	en: 'Do you allow it? I would start with this:',
	fr: "Tu m'autorises ? Je commencerais par ceci :"
};
const HOW_TO_ANSWER = {
	en: 'Answer with the buttons below, or reply yes or no.',
	fr: 'Réponds avec les boutons ci-dessous, ou par oui ou non.'
};

// The calls of the model above: a search for the budget, and the archiving of a newsletter
const SEARCH = { q: 'budget' };
const ARCHIVE = { item_id: 'newsletter-42' };

// A question as Alice's client receives it: its plain body, and the HTML Twake Chat displays, in
// which only the harness's own lines break; then the call it shows, and how to answer
function shown(
	question: readonly string[],
	call: unknown = SEARCH,
	language: 'en' | 'fr' = 'en'
): { body: string; html: string } {
	const json = JSON.stringify(call, null, 2);
	return {
		body: [question.join('\n'), json, HOW_TO_ANSWER[language]].join('\n\n'),
		html: [
			`<p>${question.join('<br />\n')}</p>`,
			`<pre><code class="language-json">${json}</code></pre>`,
			`<p>${HOW_TO_ANSWER[language]}</p>`
		].join('\n')
	};
}

describe('the question names the application in plain words', () => {
	let r: ConsentRoom;

	// The gateway serves this catalog, and every replica of the api role refreshes its own
	async function serve(domains: unknown): Promise<void> {
		r.h.apisix.contracts.spec = { ...CATALOG, 'x-twake-domains': domains };
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(CONTRACTS);
	}

	// What the harness asks after Alice's message, as her client receives it
	async function askedAfter(
		message: string,
		opening = 'This is the first time'
	): Promise<{ body: string; html: unknown }> {
		const seen = r.saying(opening).length;
		await r.client.sendText(r.room, message);
		await r.nextSaying(opening, seen);
		const question = r.saying(opening).at(seen);
		return { body: question?.body ?? '', html: question?.content['formatted_body'] };
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
		expect(await askedAfter('Find the budget in my mail')).toEqual(
			shown([
				'This is the first time I need to read your data in Twake Mail.',
				'Reading: list, search and read your mail',
				ALLOW.en
			])
		);
		// An application the catalog names without saying what reading covers there
		expect(await askedAfter('Show my photos')).toEqual(
			shown([`This is the first time I need to read your data in Twake Photos. ${ALLOW.en}`])
		);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it('names the application and says what writing covers there, before its first write', async () => {
		expect(await askedAfter('Archive the newsletter')).toEqual(
			shown(
				[
					'This is the first time I need to change your data in Twake Mail.',
					'Writing: move, archive and delete your mail',
					ALLOW.en
				],
				ARCHIVE
			)
		);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it("names an application by its id when the catalog names it neither in my language nor in the deployment's", async () => {
		expect(await askedAfter('Search my notes')).toEqual(
			shown([`This is the first time I need to read your data in notes. ${ALLOW.en}`])
		);
		// Wiki is named in French only, while Alice and the deployment speak English
		expect(await askedAfter('Open my wiki')).toEqual(
			shown([`This is the first time I need to read your data in wiki. ${ALLOW.en}`])
		);
	});

	it('takes up the words a refresh of the catalog brings, without a restart', async () => {
		expect(await askedAfter('Show my tasks')).toEqual(
			shown([`This is the first time I need to read your data in tasks. ${ALLOW.en}`])
		);
		await serve({ ...DESCRIBED, tasks: TASKS });
		const described = shown([
			'This is the first time I need to read your data in Twake Tasks.',
			'Reading: list and read your tasks and boards',
			ALLOW.en
		]);
		expect(await askedAfter('Show my tasks')).toEqual(described);
		// A refresh that fails keeps the catalog as it was, its words included
		r.h.apisix.contracts.spec = null;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(CONTRACTS);
		expect(await askedAfter('Show my tasks')).toEqual(described);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it('ignores a description of another shape with a warning, and loads the rest', async () => {
		await serve({
			...DESCRIBED,
			photos: { name: { en: 'Twake Pictures' } },
			notes: { name: { en: 'Twake Notes'.padEnd(65, '!') } },
			tasks: { name: 'Twake Tasks', read: TASKS.read },
			// A misspelt level, and languages the harness does not speak
			drive: { name: { en: 'Twake Drive' }, reads: { en: 'browse and read your files' } },
			wiki: { name: { en: 'Twake Wiki', 'fr-FR': 'Wiki Twake' } },
			boards: { name: { EN: 'Twake Boards' } }
		});
		const ignored = r.h
			.logLines()
			.filter((line) => line['msg'] === 'domain description ignored, named by its id');
		expect(ignored.map((line) => line['domain'])).toEqual(
			expect.arrayContaining(['notes', 'tasks', 'drive', 'wiki', 'boards'])
		);
		expect(ignored.every((line) => line['level'] === 40)).toBe(true);
		const problems = Object.fromEntries(ignored.map((line) => [line['domain'], line['problem']]));
		expect(problems).toMatchObject({
			drive: 'Unrecognized key: "reads"',
			wiki: 'name: Unrecognized key: "fr-FR"',
			boards: 'name: Unrecognized key: "EN"'
		});
		const asked: Record<string, string> = {
			notes: 'Search my notes',
			tasks: 'Show my tasks',
			drive: 'Find the plan in my drive',
			wiki: 'Open my wiki',
			boards: 'Show my boards'
		};
		for (const [domain, message] of Object.entries(asked)) {
			expect(await askedThroughApi(message)).toBe(
				shown([`This is the first time I need to read your data in ${domain}. ${ALLOW.en}`]).body
			);
		}
		// The rest of this catalog holds, a new name included
		expect(await askedThroughApi('Show my photos')).toBe(
			shown([`This is the first time I need to read your data in Twake Pictures. ${ALLOW.en}`]).body
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
			shown([`This is the first time I need to read your data in mail. ${ALLOW.en}`]).body
		);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it('keeps markup, links and line breaks out of its question', async () => {
		const logged = r.h.logLines().length;
		await serve({
			mail: { name: { en: '[Twake Mail](https://evil.example/login)' } },
			drive: { name: { en: 'Twake Drive' }, read: { en: 'browse <b>all</b> your files' } },
			photos: { name: { en: 'Twake Photos' }, read: { en: 'see your albums on photos.example' } },
			tasks: { name: { en: 'Twake Tasks' }, read: { en: 'write to support@twake.app' } },
			notes: { name: { en: 'Twake\u2028Notes' } },
			wiki: { name: { en: 'Twake Wiki' }, read: { en: 'read your pages\u2029and their history' } },
			boards: { name: { en: 'Twake\u0085Boards' } }
		});
		const asked: Record<string, string> = {
			mail: 'Find the budget in my mail',
			drive: 'Find the plan in my drive',
			photos: 'Show my photos',
			tasks: 'Show my tasks',
			notes: 'Search my notes',
			wiki: 'Open my wiki',
			boards: 'Show my boards'
		};
		// Each description is ignored whole, and Twake Chat shows the harness's sentence alone
		for (const [domain, message] of Object.entries(asked)) {
			expect(await askedAfter(message)).toEqual(
				shown([`This is the first time I need to read your data in ${domain}. ${ALLOW.en}`])
			);
		}
		const problems = Object.fromEntries(
			r.h
				.logLines()
				.slice(logged)
				.filter((line) => line['msg'] === 'domain description ignored, named by its id')
				.map((line) => [line['domain'], line['problem']])
		);
		expect(problems).toEqual({
			mail: expect.stringContaining('must hold no markup character'),
			drive: expect.stringContaining('must hold no markup character'),
			photos: expect.stringContaining('must hold no link, address or domain name'),
			tasks: expect.stringContaining('must hold no link, address or domain name'),
			notes: expect.stringContaining('must be one line'),
			wiki: expect.stringContaining('must be one line'),
			boards: expect.stringContaining('must be one line')
		});
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it("asks in my language, with the deployment's name for an application the catalog does not name in it", async () => {
		await serve(DESCRIBED);
		const told = r.saying('Tool:').length;
		await r.client.sendText(r.room, 'Parle-moi en français');
		expect(await r.nextSaying('Tool:', told)).toContain('"language":"fr"');

		const opening = "C'est la première fois";
		expect(await askedAfter('Cherche le budget dans mes mails', opening)).toEqual(
			shown(
				[
					"C'est la première fois que j'ai besoin de lire tes données dans Messagerie Twake.",
					'Lecture : lister, chercher et lire tes mails',
					ALLOW.fr
				],
				SEARCH,
				'fr'
			)
		);
		expect(await askedAfter("Archive la lettre d'information", opening)).toEqual(
			shown(
				[
					"C'est la première fois que j'ai besoin de modifier tes données dans Messagerie Twake.",
					'Écriture : déplacer, archiver et supprimer tes mails',
					ALLOW.fr
				],
				ARCHIVE,
				'fr'
			)
		);
		// Drive is described in English only, the deployment's language: a French question takes
		// its English name, and leaves out what reading covers there rather than say it in English
		expect(await askedAfter('Cherche le plan dans mon drive', opening)).toEqual(
			shown(
				[
					`C'est la première fois que j'ai besoin de lire tes données dans Twake Drive. ${ALLOW.fr}`
				],
				SEARCH,
				'fr'
			)
		);
		expect(await askedAfter('Ouvre mon wiki', opening)).toEqual(
			shown(
				[`C'est la première fois que j'ai besoin de lire tes données dans Wiki Twake. ${ALLOW.fr}`],
				SEARCH,
				'fr'
			)
		);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});
});
