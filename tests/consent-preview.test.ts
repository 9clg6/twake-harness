import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { call, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { grantConsent } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import {
	brokerRefusal,
	type ChatRequest,
	type ContractCall,
	type ContractReply,
	type ScriptedReply
} from './helpers/fake-apisix.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathParameter(name: string): Record<string, unknown> {
	return { name, in: 'path', required: true, schema: { type: 'string' } };
}

function jsonBody(properties: Record<string, unknown>): Record<string, unknown> {
	return { content: { 'application/json': { schema: { type: 'object', properties } } } };
}

// The owner's mail, drive and tasks as the contracts service would publish them. Sending a mail
// and archiving one offer a preview: their contract tells what a call would do without doing it.
// Deleting a mail for good offers none; sharing a file declares a preview the harness does not
// follow, and listing tasks, a read, declares one that a read never gets.
const CATALOG = {
	openapi: '3.0.3',
	paths: {
		'/contracts/v1/mail/emails': {
			post: {
				operationId: 'send_email',
				summary: 'Sends a mail in the name of the user',
				tags: ['mail.email.send.v1'],
				'x-twake-risk': 'high',
				'x-twake-preview': true,
				requestBody: jsonBody({
					to: { type: 'array', items: { type: 'string' } },
					subject: { type: 'string' },
					text: { type: 'string' }
				})
			}
		},
		'/contracts/v1/mail/emails/{email_id}/archive': {
			post: {
				operationId: 'archive_email',
				summary: 'Archives one mail of the user',
				tags: ['mail.email.archive.v1'],
				'x-twake-risk': 'low',
				'x-twake-preview': true,
				parameters: [pathParameter('email_id')]
			}
		},
		'/contracts/v1/mail/emails/{email_id}': {
			delete: {
				operationId: 'delete_email',
				summary: 'Deletes one mail of the user for good',
				tags: ['mail.email.delete.v1'],
				'x-twake-risk': 'high',
				parameters: [pathParameter('email_id')]
			}
		},
		'/contracts/v1/drive/files/{file_id}/shares': {
			post: {
				operationId: 'share_file',
				summary: 'Shares one file of the user with someone',
				tags: ['drive.file.share.v1'],
				'x-twake-risk': 'high',
				'x-twake-preview': 'yes',
				parameters: [pathParameter('file_id')],
				requestBody: jsonBody({ with: { type: 'string' } })
			}
		},
		'/contracts/v1/tasks/mine': {
			get: {
				operationId: 'list_tasks',
				summary: 'Lists the tasks assigned to the user',
				tags: ['tasks.task.read.v1'],
				'x-twake-preview': true,
				parameters: [{ name: 'due', in: 'query', required: false, schema: { type: 'string' } }]
			}
		}
	}
};

const TO_PAUL = {
	body: { to: ['paul'], subject: 'Q4 budget', text: 'Hello Paul, here is the Q4 budget.' }
};

// What the model writes alongside its mail
const SAID = 'I am sending Paul the Q4 budget, as you asked.';

interface Reply {
	readonly said?: string;
	readonly tool: string;
	readonly args: Record<string, unknown>;
}

// What the owner asks, and what the model writes and calls for it
const REQUESTS: Record<string, Reply> = {
	'Send Paul the Q4 budget': { said: SAID, tool: 'send_email', args: TO_PAUL },
	'Envoie le budget à Paul': {
		said: "J'envoie le budget à Paul.",
		tool: 'send_email',
		args: TO_PAUL
	},
	'Archive the newsletter': { tool: 'archive_email', args: { email_id: 'm-news' } },
	'Delete the old offer for good': { tool: 'delete_email', args: { email_id: 'm-offer' } },
	'Share the plan with Bob': {
		tool: 'share_file',
		args: { file_id: 'f-plan', body: { with: 'bob@test.local' } }
	},
	'What do I have to do today?': { tool: 'list_tasks', args: { due: 'today' } }
};

// A literal model: for each request of the owner it knows, it says what it is about to do and
// makes the call; it tells what a call that ran came back with, and what it read when its owner
// was not asked; it repeats anything else it hears
function literalModel(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	const content = last?.content ?? '';
	if (last?.role === 'tool' && /preview_(refused|unanswered)/.test(content)) {
		return { content: `Not asked: ${content}` };
	}
	if (last?.role === 'tool' && content.includes('"status":200')) {
		return { content: `Done: ${content}` };
	}
	const known = last?.role === 'user' ? REQUESTS[content] : undefined;
	if (known !== undefined) {
		return { content: known.said ?? null, toolCalls: call(known.tool, known.args) };
	}
	return { content: `Heard: ${content}` };
}

// What the mail application says sending the budget would do, in each language it speaks: the
// recipients it resolved, which the model never wrote, with characters that would render in a
// chat client were they not shown as data
const SEND_SUMMARY = {
	en: 'To: Paul Martin <paul@test.local> & the 3 members of **finance**\nSubject: Q4 budget\n\tAttachments: none',
	fr: 'À : Paul Martin <paul@test.local> & les 3 membres de **finance**\nObjet : Q4 budget\n\tPièces jointes : aucune'
} as const;

const ARCHIVE_SUMMARY = 'Archive “Newsletter #42” from news@test.local, received on 2026-10-01';

// The header by which a contract says it only previewed a call
const PREVIEWED = { 'x-twake-preview': 'true' } as const;

// How every request of the harness ends, in each language
const HOW_TO_ANSWER = 'Answer yes or no in your next message.';
const FRENCH_HOW_TO_ANSWER = 'Réponds par oui ou non dans ton prochain message.';

const HIGH_RISK_IN_MAIL =
	'Actions like this one in mail need your yes each time. Shall I do this one, exactly as below?';

// What the harness tells its owner when the application refused the call they allowed, as what it
// acts on changed since they saw its preview
const CHANGED =
	'What this action affects changed since I showed it to you, so I did not do it. Ask me again if you still need it.';
const FRENCH_CHANGED =
	"Ce sur quoi porte cette action a changé depuis que je te l'ai montrée, je ne l'ai donc pas faite. Redemande-moi si tu en as encore besoin.";

// What the harness tells its owner when the application, asked only what a call would do, did it
const ACTED =
	'I asked mail what this action would do, to show you before you decide, but it did the action right away, without waiting for your yes. Check the result in mail.';

// A text that is not the harness's, as Alice's client shows it in plain text: quoted line by line
// under the harness's label
function quoted(label: string, text: string): string {
	return [label, ...text.split('\n').map((line) => `> ${line}`)].join('\n');
}

// A request as Alice's client shows it in plain text: what the model wrote, if anything, quoted
// under the harness's label; the harness's question; what she is shown of the call; and how to
// answer
function asked(question: string, shown: string, said?: string): string {
	const words = said === undefined ? [] : [quoted('Your assistant wrote:', said)];
	return [...words, question, shown, HOW_TO_ANSWER].join('\n\n');
}

// What the mail application said a call would do, as a request shows it in the call's place
function describedByMail(summary: string): string {
	return quoted('mail describes it as:', summary);
}

function frozen(args: unknown): string {
	return JSON.stringify(args, null, 2);
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The bytes a text takes in the JSON of the event that carries it
function eventBytes(text: string): number {
	return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

// What a summary of the mail application takes of the event that shows it: quoted under the
// harness's label in the plain text, and as code under that label in the HTML
function summaryBytes(summary: string): number {
	return (
		eventBytes(describedByMail(summary)) +
		eventBytes('<p>mail describes it as:</p>') +
		eventBytes(`<pre><code>${escapeHtml(summary)}</code></pre>`)
	);
}

// The longest summary of x a request shows whole, within the 16 KiB a call may take of the event:
// each x takes a byte of the plain text and a byte of the HTML
const LARGEST_SUMMARY = 'x'.repeat(1 + Math.floor((16_384 - summaryBytes('x')) / 2));

describe('my assistant shows me what the application says an action would do before I confirm it', () => {
	let r: ConsentRoom;
	// The state of what the mail application acts on, such as the members of the finance list: a
	// preview's digest covers it
	let revision = 1;
	const digest = (): string => `sha256:r${revision}`;

	// The mail application behind the gateway. Asked for a preview, it says what the call would do,
	// in the language asked for, with the digest of what it acts on now, says it only previewed the
	// call, and does nothing; asked to act with a digest that no longer matches, it refuses with a
	// 409, and does nothing either.
	function mailApp(c: ContractCall): ContractReply {
		if (c.headers['x-twake-preview'] !== undefined) {
			const summary = c.path.endsWith('/archive')
				? ARCHIVE_SUMMARY
				: SEND_SUMMARY[c.headers['accept-language'] === 'fr' ? 'fr' : 'en'];
			return { status: 200, headers: PREVIEWED, body: { summary, digest: digest() } };
		}
		const previewed = c.headers['x-twake-preview-digest'];
		if (previewed !== undefined && previewed !== digest()) {
			return { status: 409, body: { error: 'what this call acts on changed' } };
		}
		return { status: 200, body: { done: `${c.method} ${c.path}` } };
	}

	beforeAll(async () => {
		r = await startConsentRoom({
			// Many turns of one owner in a row: admission is the subject of its own suite
			ADMISSION_USER_PER_MINUTE: '100',
			// The least the harness waits for a contract, so that one can be slower than that
			CONTRACTS_TIMEOUT_MS: '2000'
		});
		r.h.apisix.contracts.spec = CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(5);
		r.h.apisix.llm.script = literalModel;
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});
	beforeEach(() => {
		r.h.apisix.contracts.calls.length = 0;
		r.h.apisix.contracts.handler = mailApp;
		revision = 1;
	});

	// The assistant's messages in Alice's room that match, as her client received them
	function from(matches: (body: string) => boolean): DecryptedMessage[] {
		return r.client.messages.filter(
			(m) => m.roomId === r.room && m.sender === r.assistantId && matches(m.body)
		);
	}

	async function nextFrom(
		matches: (body: string) => boolean,
		seen: number
	): Promise<DecryptedMessage> {
		for (let i = 0; i < 120; i += 1) {
			const latest = from(matches).at(seen);
			if (latest !== undefined) return latest;
			await sleep(250);
		}
		throw new Error('nothing new from the assistant');
	}

	// The harness's requests in English
	const isRequest = (body: string): boolean => body.endsWith(HOW_TO_ANSWER);

	function requests(): DecryptedMessage[] {
		return from(isRequest);
	}

	// The info lines of the calls that waited for Alice
	function waits(): Record<string, unknown>[] {
		return r.h.logLines().filter((l) => l['msg'] === 'contract call waits for its owner');
	}

	// What every replica of the api role serves on /metrics, as a scraper reads each pod
	async function apiMetrics(): Promise<string> {
		const served = await Promise.all(
			r.h.apps.map(async (app) => (await app.inject({ method: 'GET', url: '/metrics' })).body)
		);
		return served.join('\n');
	}

	// The headers by which the gateway tells a preview from the action, call by call
	function previewHeaders(): (string | null)[][] {
		return r.h.apisix.contracts.calls.map((c) => [
			c.headers['x-twake-preview'] ?? null,
			c.headers['x-twake-preview-digest'] ?? null
		]);
	}

	// Everything the model was ever sent, in every turn
	function seenByModel(): string {
		return JSON.stringify(r.h.apisix.llm.calls.map((c) => c.request.messages));
	}

	// A direct tool call of Alice's through the API, on one replica of the api role, as a load
	// balancer may send it there
	async function toolOn(
		replica: number,
		tool: string,
		args: Record<string, unknown>
	): Promise<Record<string, unknown>> {
		const app = r.h.apps[replica];
		if (app === undefined) throw new Error(`no replica ${replica}`);
		const reply = await app.inject({
			method: 'POST',
			url: '/v1/tool',
			headers: { authorization: `Bearer ${await r.h.issuer.mint({ sub: 'alice@test.local' })}` },
			payload: { tool, arguments: args }
		});
		return reply.json<Record<string, unknown>>();
	}

	it('asks before its first write in my mail with what the application says it would do, then writes there at once, unpreviewed', async () => {
		const seen = requests().length;
		const sentFrom = await r.client.sendText(r.room, 'Archive the newsletter');
		const request = await nextFrom(isRequest, seen);
		expect(request.body).toBe(
			asked(
				'This is the first time I need to change your data in mail. Do you allow it? I would start with this:',
				describedByMail(ARCHIVE_SUMMARY)
			)
		);
		// The gateway received the preview alone: the call as the model wrote it, in my name and
		// under the id of my message, asking what it would do
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
		const previewed = r.h.apisix.contracts.calls[0];
		expect(`${previewed?.method} ${previewed?.path}`).toBe(
			'POST /contracts/v1/mail/emails/m-news/archive'
		);
		expect(previewed?.headers).toMatchObject({
			'x-twake-preview': 'true',
			'x-twake-on-behalf-of': 'alice@test.local',
			'x-twake-contract': 'mail.email.archive.v1',
			'x-correlation-id': sentFrom
		});
		// My yes archives it, with the digest of what I saw
		let done = r.saying('Done:').length;
		await r.client.react(r.room, request.eventId, '✅');
		expect(await r.nextSaying('Done:', done)).toContain('/archive');
		expect(previewHeaders()).toEqual([
			['true', null],
			[null, 'sha256:r1']
		]);
		// It also let my assistant write in my mail: the next archive asks nothing, so the
		// application is not asked for a preview either
		done = r.saying('Done:').length;
		await r.client.sendText(r.room, 'Archive the newsletter');
		expect(await r.nextSaying('Done:', done)).toContain('/archive');
		expect(requests()).toHaveLength(seen + 1);
		expect(previewHeaders()).toEqual([
			['true', null],
			[null, 'sha256:r1'],
			[null, null]
		]);
		// What the application said reached me alone, never the model
		expect(seenByModel()).not.toContain('Newsletter #42');
	});

	it('shows what the application says a mail would do, as its words, and sends it on my yes with the digest of what I saw', async () => {
		await grantConsent(r.h.db, 'alice@test.local', 'mail', 'write');
		const seen = requests().length;
		const sentFrom = await r.client.sendText(r.room, 'Send Paul the Q4 budget');
		const request = await nextFrom(isRequest, seen);
		// What the model wrote, the harness's question, then the application's summary in the
		// mail's place, under a label of the harness's: in my client, code whose markup renders
		// nothing
		expect(request.body).toBe(asked(HIGH_RISK_IN_MAIL, describedByMail(SEND_SUMMARY.en), SAID));
		expect(request.content['formatted_body']).toBe(
			[
				'<p>Your assistant wrote:</p>',
				`<blockquote>${SAID}</blockquote>`,
				`<p>${HIGH_RISK_IN_MAIL}</p>`,
				'<p>mail describes it as:</p>',
				`<pre><code>${escapeHtml(SEND_SUMMARY.en)}</code></pre>`,
				`<p>${HOW_TO_ANSWER}</p>`
			].join('\n')
		);
		// Before my answer, the gateway received the preview alone, in my language
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
		const previewed = r.h.apisix.contracts.calls[0];
		expect(`${previewed?.method} ${previewed?.path}`).toBe('POST /contracts/v1/mail/emails');
		expect(previewed?.body).toEqual(TO_PAUL.body);
		expect(previewed?.headers).toMatchObject({
			'x-twake-preview': 'true',
			'accept-language': 'en',
			'x-twake-on-behalf-of': 'alice@test.local',
			'x-twake-contract': 'mail.email.send.v1',
			'x-correlation-id': sentFrom
		});
		expect(previewed?.headers).not.toHaveProperty('x-twake-preview-digest');
		// The harness keeps the digest of what I was shown until I answer
		expect((await r.previewDigestsOf('mail')).at(-1)).toBe('sha256:r1');

		// My ✅ sends that very mail, with the digest of what I saw and never the preview header
		const done = r.saying('Done:').length;
		await r.client.react(r.room, request.eventId, '✅');
		expect(await r.nextSaying('Done:', done)).toContain('POST /contracts/v1/mail/emails');
		expect(r.h.apisix.contracts.calls).toHaveLength(2);
		const sent = r.h.apisix.contracts.calls[1];
		expect(sent?.body).toEqual(TO_PAUL.body);
		expect(sent?.headers).toMatchObject({
			'x-twake-preview-digest': 'sha256:r1',
			'x-correlation-id': sentFrom
		});
		expect(sent?.headers).not.toHaveProperty('x-twake-preview');
		// Once the mail went, its digest is erased with it
		expect((await r.previewDigestsOf('mail')).at(-1)).toBeNull();
		// The model never read what the application said: the conversation keeps the request with
		// the mail as the model wrote it
		expect(seenByModel()).not.toContain('Paul Martin');
		expect(seenByModel()).toContain(
			JSON.stringify(asked(HIGH_RISK_IN_MAIL, frozen(TO_PAUL), SAID))
		);

		// The next mail is previewed again, and my no sends nothing and erases its digest too
		const next = requests().length;
		await r.client.sendText(r.room, 'Send Paul the Q4 budget');
		const again = await nextFrom(isRequest, next);
		expect((await r.previewDigestsOf('mail')).at(-1)).toBe('sha256:r1');
		const acknowledged = r.saying('All right').length;
		await r.client.react(r.room, again.eventId, '❌');
		await r.nextSaying('All right', acknowledged);
		expect((await r.previewDigestsOf('mail')).at(-1)).toBeNull();
		expect(previewHeaders()).toEqual([
			['true', null],
			[null, 'sha256:r1'],
			['true', null]
		]);
		// An operator reads that each request showed a preview, never what it said nor its digest
		expect(waits().at(-1)).toMatchObject({ reasons: ['high_risk'], preview: true });
		const logged = JSON.stringify(r.h.logLines());
		expect(logged).not.toContain('Paul Martin');
		expect(logged).not.toContain('sha256:r1');
	});

	it('tells me itself that it did nothing when what a mail affects changed since I saw it, and the model reads why', async () => {
		await grantConsent(r.h.db, 'alice@test.local', 'mail', 'write');
		const seen = requests().length;
		await r.client.sendText(r.room, 'Send Paul the Q4 budget');
		const request = await nextFrom(isRequest, seen);
		// Before I answer, someone joins the finance list: the mail would reach other people
		revision = 2;
		const llmCalls = r.h.apisix.llm.calls.length;
		const notices = r.saying(CHANGED).length;
		await r.client.react(r.room, request.eventId, '✅');
		expect(await r.nextSaying(CHANGED, notices)).toBe(CHANGED);
		// The application refused the mail, which carried the digest of what I saw: nothing went, and
		// the model did not speak in the harness's stead
		expect(previewHeaders()).toEqual([
			['true', null],
			[null, 'sha256:r1']
		]);
		expect(r.h.apisix.llm.calls).toHaveLength(llmCalls);
		expect((await r.previewDigestsOf('mail')).at(-1)).toBeNull();
		expect(
			r.h
				.logLines()
				.filter((l) => l['msg'] === 'pending call replayed')
				.at(-1)
		).toMatchObject({ tool: 'send_email', httpStatus: 409, changedSincePreview: true });
		expect(await apiMetrics()).toContain(
			'harness_consent_replays_total{domain="mail",level="write",reason="high_risk",outcome="failed"} 1'
		);

		// In my next turn, the model reads the mail it tried, the application's refusal and what I
		// was told
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'What happened?');
		await r.nextSaying('Heard:', heard);
		const history = r.h.apisix.llm.calls.at(-1)?.request.messages ?? [];
		// The latest mail it replayed: the conversation holds the earlier ones too
		const tried =
			history
				.flatMap((m, index) =>
					m.tool_calls?.some(
						(c) => c.id.startsWith('replay_') && c.function.name === 'send_email'
					) === true
						? [index]
						: []
				)
				.at(-1) ?? -1;
		expect(tried).toBeGreaterThan(-1);
		expect(JSON.parse(history[tried]?.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual(
			TO_PAUL
		);
		expect(history[tried + 1]).toMatchObject({ role: 'tool', name: 'send_email' });
		expect(JSON.parse(history[tried + 1]?.content ?? '{}')).toMatchObject({ status: 409 });
		expect(history[tried + 2]).toEqual({ role: 'assistant', content: CHANGED });
	});

	it('tells me plainly when the application did what it was only asked about, and stops asking it until its catalog loads again', async () => {
		await grantConsent(r.h.db, 'alice@test.local', 'mail', 'write');
		// The mail application takes the preview header for nothing: asked what a mail would do, it
		// sends it, and says nothing of a preview
		r.h.apisix.contracts.handler = (c) => ({
			status: 200,
			body: { done: `${c.method} ${c.path}` }
		});
		const seen = requests().length;
		const notices = r.saying(ACTED).length;
		await r.client.sendText(r.room, 'Send Paul the Q4 budget');
		expect(await r.nextSaying(ACTED, notices)).toBe(ACTED);
		expect(requests()).toHaveLength(seen);
		expect(previewHeaders()).toEqual([['true', null]]);
		// Its operator reads an error
		const acted = (): Record<string, unknown>[] =>
			r.h
				.logLines()
				.filter(
					(l) =>
						l['msg'] === 'contract acted on a preview, previews stop until the catalog loads again'
				);
		expect(acted().map((l) => [l['level'], l['contract'], l['problem']])).toEqual([
			[50, 'mail.email.send.v1', 'the answer does not carry x-twake-preview: true']
		]);
		// In my next turn, the model reads that the mail went, and what I was told
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Did it go?');
		await r.nextSaying('Heard:', heard);
		const history = r.h.apisix.llm.calls.at(-1)?.request.messages ?? [];
		const made: unknown = JSON.parse(history.at(-3)?.content ?? '{}');
		expect(history.at(-3)).toMatchObject({ role: 'tool', name: 'send_email' });
		expect(made).toEqual({
			status: 'made_without_owner',
			hint: expect.any(String),
			answer: { status: 200 }
		});
		expect(JSON.stringify(made)).not.toMatch(/not made/i);
		expect(history.at(-2)).toEqual({ role: 'assistant', content: ACTED });

		// A replica whose preview acted asks the application for no more previews: the next mail
		// waits for me with the call as the model wrote it, and nothing reaches the gateway
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(5);
		r.h.apisix.contracts.calls.length = 0;
		expect(await toolOn(0, 'send_email', TO_PAUL)).toMatchObject({ status: 'made_without_owner' });
		expect(previewHeaders()).toEqual([['true', null]]);
		await toolOn(0, 'send_email', TO_PAUL);
		expect(previewHeaders()).toEqual([['true', null]]);
		// Once its catalog loads again, it asks the application again. One that says it previewed the
		// mail, yet gives a digest that could not go back in a header, is taken to have sent it all
		// the same.
		expect(await r.h.apps[0]?.agent.contracts.load()).toBe(5);
		r.h.apisix.contracts.handler = (c) =>
			c.headers['x-twake-preview'] === undefined
				? mailApp(c)
				: {
						status: 200,
						headers: PREVIEWED,
						body: { summary: SEND_SUMMARY.en, digest: 'r1\r\nx-twake-on-behalf-of: bob@test.local' }
					};
		expect(await toolOn(0, 'send_email', TO_PAUL)).toMatchObject({ status: 'made_without_owner' });
		expect(previewHeaders()).toEqual([
			['true', null],
			['true', null]
		]);
		expect(acted().at(-1)).toMatchObject({
			level: 50,
			problem: 'digest: must be 1 to 256 letters, digits or + / = . _ : -'
		});
		// So is one whose summary holds a character that would make it read otherwise, such as one
		// that turns the text right to left
		expect(await r.h.apps[0]?.agent.contracts.load()).toBe(5);
		r.h.apisix.contracts.handler = (c) =>
			c.headers['x-twake-preview'] === undefined
				? mailApp(c)
				: {
						status: 200,
						headers: PREVIEWED,
						body: { summary: 'To: Paul Martin <moc.tset@luap\u202e>', digest: digest() }
					};
		expect(await toolOn(0, 'send_email', TO_PAUL)).toMatchObject({ status: 'made_without_owner' });
		expect(previewHeaders()).toHaveLength(3);
		expect(acted().at(-1)).toMatchObject({
			level: 50,
			problem: 'summary: must hold no control or format character but line feeds and tabs'
		});
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(5);
	});

	it('shows an action whose application offers no preview as the model wrote it, and nothing reaches the gateway before my yes', async () => {
		await grantConsent(r.h.db, 'alice@test.local', 'mail', 'write');
		const seen = requests().length;
		await r.client.sendText(r.room, 'Delete the old offer for good');
		const request = await nextFrom(isRequest, seen);
		const call = frozen({ email_id: 'm-offer' });
		expect(request.body).toBe(asked(HIGH_RISK_IN_MAIL, call));
		expect(request.content['formatted_body']).toContain(
			`<pre><code class="language-json">${call}</code></pre>`
		);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
		const done = r.saying('Done:').length;
		await r.client.react(r.room, request.eventId, '✅');
		expect(await r.nextSaying('Done:', done)).toContain('DELETE /contracts/v1/mail/emails/m-offer');
		expect(previewHeaders()).toEqual([[null, null]]);
	});

	it('never asks an application for a preview it did not declare as the harness reads one', async () => {
		// Sharing declares a preview the harness does not know: it shows the call as the model wrote
		// it. Listing tasks is a read, whose question shows no call. Nothing reaches the gateway
		// before my answer.
		const share = 'Share the plan with Bob';
		for (const [message, expected] of [
			[
				share,
				asked(
					'This is the first time I need to change your data in drive, and actions like this one need your yes each time. Do you allow it, starting with this one, exactly as below?',
					frozen(REQUESTS[share]?.args)
				)
			],
			[
				'What do I have to do today?',
				[
					'This is the first time I need to read your data in tasks. Do you allow it?',
					HOW_TO_ANSWER
				].join('\n\n')
			]
		] as const) {
			const seen = requests().length;
			await r.client.sendText(r.room, message);
			const request = await nextFrom(isRequest, seen);
			expect(request.body).toBe(expected);
			const acknowledged = r.saying('All right').length;
			await r.client.react(r.room, request.eventId, '❌');
			await r.nextSaying('All right', acknowledged);
		}
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
		// Its operator is told of each preview the harness does not follow, once
		const ignored = (): Record<string, unknown>[] =>
			r.h.logLines().filter((l) => l['msg'] === 'contract preview ignored');
		const warned = ignored();
		expect(
			new Set(warned.map((l) => `${String(l['contract'])} ${JSON.stringify(l['declared'])}`))
		).toEqual(new Set(['drive.file.share.v1 "yes"', 'tasks.task.read.v1 true']));
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(5);
		expect(ignored()).toHaveLength(warned.length);
	});

	it('asks nothing when the application answers a preview with an error, or not in time, and the model reads what it can', async () => {
		await grantConsent(r.h.db, 'alice@test.local', 'mail', 'write');
		// An application that fails, then one slower than the harness waits for
		const replies: [ContractReply, string][] = [
			[{ status: 503, body: { error: 'unavailable' } }, 'preview_refused'],
			[
				{
					status: 200,
					headers: PREVIEWED,
					body: { summary: SEND_SUMMARY.en, digest: 'sha256:r1' },
					delayMs: 3_000
				},
				'preview_unanswered'
			]
		];
		for (const [reply, error] of replies) {
			r.h.apisix.contracts.calls.length = 0;
			r.h.apisix.contracts.handler = () => reply;
			const seen = requests().length;
			const notAsked = r.saying('Not asked:').length;
			await r.client.sendText(r.room, 'Send Paul the Q4 budget');
			const told: unknown = JSON.parse(
				(await r.nextSaying('Not asked:', notAsked)).slice('Not asked: '.length)
			);
			expect(told).toMatchObject({ error });
			// Whatever it reads, the model is never told that the call was not made
			expect(JSON.stringify(told)).not.toMatch(/not made/i);
			expect(requests()).toHaveLength(seen);
			expect(previewHeaders()).toEqual([['true', null]]);
		}
		// It reads the error as the application gave it, and that what a silent one did is unknown
		const [refused, unanswered] = r
			.saying('Not asked:')
			.slice(-2)
			.map((m) => JSON.parse(m.body.slice('Not asked: '.length)) as Record<string, unknown>);
		expect(refused).toMatchObject({ answer: { status: 503, body: { error: 'unavailable' } } });
		expect(String(unanswered?.['hint'])).toContain('unknown');
		// Its operator reads why, never what the application answered
		const failed = r.h.logLines().filter((l) => l['msg'] === 'contract preview failed');
		expect(failed.map((l) => [l['level'], l['contract'], l['problem']])).toEqual([
			[40, 'mail.email.send.v1', 'status 503'],
			[40, 'mail.email.send.v1', 'no answer']
		]);
	});

	it('never asks about a call whose summary it cannot show whole, and shows the largest it can', async () => {
		await grantConsent(r.h.db, 'alice@test.local', 'mail', 'write');
		// A summary takes at most 16 KiB of the event, as plain text and as HTML together, as the call
		// would: the longest summary of x, and not one x more
		let summary = `${LARGEST_SUMMARY}x`;
		r.h.apisix.contracts.handler = (c) =>
			c.headers['x-twake-preview'] === undefined
				? mailApp(c)
				: {
						status: 200,
						headers: PREVIEWED,
						body: { summary, digest: digest() }
					};
		const seen = requests().length;
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Send Paul the Q4 budget');
		// Nothing waits for me, and the model reads that the call is too large to confirm
		expect(await r.nextSaying('Heard:', heard)).toContain('too_large_to_confirm');
		expect(requests()).toHaveLength(seen);
		expect(previewHeaders()).toEqual([['true', null]]);
		summary = LARGEST_SUMMARY;
		await r.client.sendText(r.room, 'Send Paul the Q4 budget');
		const request = await nextFrom(isRequest, seen);
		expect(request.body).toBe(asked(HIGH_RISK_IN_MAIL, describedByMail(LARGEST_SUMMARY), SAID));
	});

	it('asks for my permission at the broker first when it refuses the preview, then shows me the preview', async () => {
		await grantConsent(r.h.db, 'alice@test.local', 'mail', 'write');
		let refusals = 1;
		r.h.apisix.contracts.handler = (c) => {
			if (refusals === 0) return mailApp(c);
			refusals -= 1;
			return brokerRefusal('delegation_missing');
		};
		let seen = requests().length;
		await r.client.sendText(r.room, 'Send Paul the Q4 budget');
		const permission = await nextFrom(isRequest, seen);
		expect(permission.body).toBe(
			`To change your data in mail, I need your permission to act on your behalf, and you have not given it yet.\nShall I try again? ${HOW_TO_ANSWER}`
		);
		expect(previewHeaders()).toEqual([['true', null]]);
		// Once I gave it, my yes asks the application again, and I see what the mail would do
		seen = requests().length;
		await r.client.react(r.room, permission.eventId, '✅');
		const request = await nextFrom(isRequest, seen);
		expect(request.body).toBe(asked(HIGH_RISK_IN_MAIL, describedByMail(SEND_SUMMARY.en)));
		expect(previewHeaders()).toEqual([
			['true', null],
			['true', null]
		]);
		// My yes to that sends the mail, with the digest of what I saw
		const done = r.saying('Done:').length;
		await r.client.react(r.room, request.eventId, '✅');
		await r.nextSaying('Done:', done);
		expect(previewHeaders()).toEqual([
			['true', null],
			['true', null],
			[null, 'sha256:r1']
		]);
	});

	it('shows the summary in a turn through the API too, and nothing acts', async () => {
		await grantConsent(r.h.db, 'alice@test.local', 'mail', 'write');
		const turn = await r.h.api.post<{ answer: string }>('alice@test.local', '/v1/chat', {
			message: 'Send Paul the Q4 budget'
		});
		expect(turn.status).toBe(200);
		expect(turn.body.answer).toBe(asked(HIGH_RISK_IN_MAIL, describedByMail(SEND_SUMMARY.en), SAID));
		expect(previewHeaders()).toEqual([['true', null]]);
	});

	it('asks the application in my language, and tells me in it that nothing was done', async () => {
		await grantConsent(r.h.db, 'alice@test.local', 'mail', 'write');
		const switched = await r.h.api.tool('alice@test.local', 'set_language', { language: 'fr' });
		expect(switched.body).toEqual({ success: true, language: 'fr' });
		const isFrenchRequest = (body: string): boolean => body.endsWith(FRENCH_HOW_TO_ANSWER);
		const seen = from(isFrenchRequest).length;
		await r.client.sendText(r.room, 'Envoie le budget à Paul');
		const request = await nextFrom(isFrenchRequest, seen);
		expect(request.body).toBe(
			[
				quoted('Ton assistant a écrit :', "J'envoie le budget à Paul."),
				'Dans mail, les actions comme celle-ci demandent ton accord à chaque fois. Je fais celle-ci, exactement comme ci-dessous ?',
				quoted('Description donnée par mail :', SEND_SUMMARY.fr),
				FRENCH_HOW_TO_ANSWER
			].join('\n\n')
		);
		expect(r.h.apisix.contracts.calls[0]?.headers['accept-language']).toBe('fr');
		revision = 2;
		const notices = r.saying(FRENCH_CHANGED).length;
		await r.client.sendText(r.room, 'oui');
		expect(await r.nextSaying(FRENCH_CHANGED, notices)).toBe(FRENCH_CHANGED);
		expect(previewHeaders()).toEqual([
			['true', null],
			[null, 'sha256:r1']
		]);
	});
});
