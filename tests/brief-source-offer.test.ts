import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BRIEF_NOW_TOOL } from '../src/briefs/now.js';
import { BRIEF_DOMAINS } from '../src/briefs/questions.js';
import { runBriefPass } from '../src/briefs/schedule.js';
import { withPrincipal } from '../src/db/client.js';
import { findChoices, listListened, saveListening } from '../src/sources/repository.js';
import { SOURCE_REGISTRY, type Source, type SourceEntry } from '../src/sources/sources.js';
import { lastUser, until } from './helpers/activity.js';
import {
	BRIEF_CATALOG,
	LIST_EMAILS,
	LIST_EVENTS,
	LIST_MAILBOXES,
	LIST_TASKS,
	MAILBOXES,
	seenEveryDay
} from './helpers/brief.js';
import { makeSettableClock } from './helpers/clock.js';
import {
	call,
	QUESTION_CONTENT_KEY,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';
import { grantConsent, withdrawConsent } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import {
	BROKER_CONSENT_URL,
	brokerRefusal,
	type ChatRequest,
	type ContractReply,
	type ScriptedReply
} from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
// Where the content of a brief tells Alice's client that it is one, and of which day
const BRIEF_CONTENT_KEY = 'app.twake.assistant.brief';
// What the model writes as the brief
const WRITTEN = 'Ce matin : rien de prévu, ta journée est libre.';

// The brief's contracts, which name Calendar, Mail and Drive to their owners
const CATALOG = {
	...BRIEF_CATALOG,
	'x-twake-domains': {
		calendar: { name: { en: 'Twake Calendar', fr: 'Twake Calendar' } },
		mail: { name: { en: 'Twake Mail', fr: 'Twake Mail' } },
		drive: { name: { en: 'Twake Drive', fr: 'Twake Drive' } }
	}
};

// The source offer a brief makes Alice after it, of listening to an application
function sourceOffer(application: string): string {
	return `Veux-tu que j'écoute ${application} ? Ton brief te dirait ce qui t'y arrive.`;
}

// The registry as it will be once briefs make source offers, as they will of the Chat and Space:
// one of her calendar, which her assistant listens to by default, of her mail and of her drive
const OFFERING: readonly SourceEntry[] = SOURCE_REGISTRY.map((entry) =>
	['calendar', 'mail', 'drive'].includes(entry.source)
		? { ...entry, offer: (_messages, application) => sourceOffer(application) }
		: entry
);

// What the harness says once Alice had her assistant listen to her drive, which only her brief
// reads, and once she said no to one of its questions
const LISTENING_TO_DRIVE = "J'écoute Twake Drive : ton brief te dit ce qui t'y arrive.";
const REFUSED = "D'accord, je ne le fais pas.";

// What Alice asks her assistant, and the call a literal model makes for each
const ASKS: Readonly<Record<string, { readonly tool: string; readonly args: unknown }>> = {
	'Écoute mon drive': { tool: 'listen_to_source', args: { source: 'drive' } },
	'Mon brief ?': { tool: BRIEF_NOW_TOOL, args: {} }
};

// A literal model: it writes the brief, makes the call each of Alice's asks needs and says what the
// call answered, and repeats anything else it hears
function offeringModel(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	if (last?.role === 'tool') return { content: `Told: ${last.content ?? ''}` };
	const told = lastUser(request);
	if (told.startsWith('[brief]')) return { content: WRITTEN };
	const ask = ASKS[told];
	return ask === undefined ? { content: `echo: ${told}` } : { toolCalls: call(ask.tool, ask.args) };
}

const isBrief = (m: DecryptedMessage): boolean => m.content[BRIEF_CONTENT_KEY] !== undefined;
const isQuestion = (m: DecryptedMessage): boolean => m.content[QUESTION_CONTENT_KEY] !== undefined;

describe('my brief offers me once, after it, to listen to an application I never chose for', () => {
	let r: ConsentRoom;
	// The room of the assistant I have
	let room: string;
	let creatorId: string;
	// My conversation with the creator
	let creatorRoom: string;
	const clock = makeSettableClock('2026-10-12T06:00:00Z');
	// What the platform's broker says of Alice's permission for her assistant to act for her: the
	// gateway relays its refusal for every contract call until she gives it
	let broker: ContractReply | null = null;

	// Everything Alice's client received from her assistant in her room, oldest first
	const said = (): DecryptedMessage[] =>
		r.client.messages.filter((m) => m.roomId === room && m.sender === r.assistantId);

	// The first message her assistant sent after the first `seen` that is what is waited for, once
	// it came: a status message of a turn may come before it
	async function nextOf(
		seen: number,
		what: string,
		is: (m: DecryptedMessage) => boolean
	): Promise<DecryptedMessage> {
		await until(what, () => said().slice(seen).some(is));
		const message = said().slice(seen).find(is);
		if (message === undefined) throw new Error(`no ${what}`);
		return message;
	}

	// The worker role's pass, as it runs every minute, at the time the clock says
	async function pass(at: string): Promise<void> {
		clock.set(at);
		const app = r.h.apps[0];
		if (app === undefined) throw new Error('no api role');
		await runBriefPass({ config: r.h.config, db: r.h.db, log: app.log, clock });
	}

	// The brief of a morning, as Alice's client received it
	async function briefOf(at: string): Promise<DecryptedMessage> {
		const seen = said().length;
		await pass(at);
		const brief = await nextOf(seen, `the brief of ${at}`, isBrief);
		expect(brief.content[BRIEF_CONTENT_KEY]).toEqual({ date: at.slice(0, 10) });
		return brief;
	}

	// What her assistant says after something she did, once it said it
	async function told(act: () => Promise<unknown>, text: string): Promise<void> {
		const seen = said().length;
		await act();
		await nextOf(seen, `« ${text} »`, (m) => m.body === text);
	}

	// The question her assistant asks her once she asked it to listen to her drive: first, whether it
	// may read there
	async function askToListenToDrive(): Promise<void> {
		const seen = said().length;
		await r.client.sendText(room, 'Écoute mon drive');
		const question = await nextOf(seen, 'the question about her drive', isQuestion);
		await r.requestAskedIn(question.eventId, 'drive');
	}

	// What Alice chose for an application, as if she had told her assistant
	const choose = (source: Source, listening: boolean): Promise<void> =>
		withPrincipal(r.h.db, { id: ALICE }, (tx) => saveListening(tx, ALICE, source, listening));

	// What she chose for each application: to listen there, to stop it, or nothing yet
	const choices = (): Promise<Readonly<Record<Source, string>>> =>
		withPrincipal(r.h.db, { id: ALICE }, (tx) => findChoices(tx, ALICE));

	// The applications her assistant listens to
	const listened = (): Promise<string[]> =>
		withPrincipal(r.h.db, { id: ALICE }, (tx) => listListened(tx, ALICE));

	// The applications she allowed her assistant to read, as she reads them through the API
	async function allowed(): Promise<string[]> {
		const listed = await r.h.api.get<{ consents: { domain: string; level: string }[] }>(
			ALICE,
			'/v1/consents'
		);
		return listed.body.consents.filter((c) => c.level === 'read').map((c) => c.domain);
	}

	// Her open request about an application, as if a day and a minute had gone by since it was
	// asked: past its lifetime, the suite's day, though nothing closed it yet
	const pastLifetime = (domain: string): Promise<unknown> =>
		withPrincipal(
			r.h.db,
			{ id: ALICE },
			(tx) => tx.sql`update pending_calls set created_at = created_at - interval '1 day 1 minute'
				where owner = ${ALICE} and domain = ${domain} and status = 'open'`
		);

	// Whether the harness logged a line with these fields
	const logged = (fields: Readonly<Record<string, unknown>>): boolean =>
		r.h
			.logLines()
			.some((line) => Object.entries(fields).every(([key, value]) => line[key] === value));

	// The first message the creator writes me, once I wrote it a message, that its answer starts with,
	// as it may tell me something else first
	async function answerTo(text: string, answer: string): Promise<void> {
		const fromCreator = (): DecryptedMessage[] =>
			r.client.messages.filter((m) => m.roomId === creatorRoom && m.sender === creatorId);
		const seen = fromCreator().length;
		await r.client.sendText(creatorRoom, text);
		await until(`the creator answered « ${text} »`, () =>
			fromCreator()
				.slice(seen)
				.some((m) => m.body.startsWith(answer))
		);
	}

	beforeAll(async () => {
		r = await startConsentRoom(
			{
				ASSISTANT_LOCALE: 'fr',
				ASSISTANT_TIMEZONE: 'Europe/Paris',
				BRIEF_ENABLED: 'true',
				BROKER_CONSENT_URL,
				ADMISSION_USER_PER_MINUTE: '120'
			},
			{ clock, sources: OFFERING }
		);
		room = r.room;
		r.h.apisix.contracts.spec = CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBeGreaterThan(0);
		// A free day, no invitation, an empty inbox and no task, while the broker refuses nothing
		r.h.apisix.contracts.handler = (c) => {
			if (broker !== null) return broker;
			if (c.path === LIST_MAILBOXES) return { status: 200, body: MAILBOXES };
			if (c.path === LIST_EMAILS) return { status: 200, body: { emails: [], next_cursor: null } };
			if (c.path === LIST_TASKS) return { status: 200, body: { tasks: [], truncated: false } };
			if (c.path === LIST_EVENTS) {
				return { status: 200, body: { time_zone: 'Europe/Paris', events: [], truncated: false } };
			}
			return { status: 404, body: {} };
		};
		r.h.apisix.llm.script = offeringModel;
		creatorId = r.h.role.creatorUserId;
		creatorRoom = await r.client.createDirectRoom(creatorId);
		await r.client.waitForMessage(creatorRoom, creatorId, (t) => t.includes('/newbot'));
	}, 240_000);

	// Each case starts with her brief's reads allowed, her drive not read, no choice made for any
	// application, no source offer made, the platform holding her permission, and no question waiting
	// for her answer nor yes waiting to run
	beforeEach(async () => {
		broker = null;
		await seenEveryDay(r.h.db, ALICE);
		for (const domain of BRIEF_DOMAINS) await grantConsent(r.h.db, ALICE, domain, 'read');
		await withdrawConsent(r.h.db, ALICE, 'drive', 'read');
		await withPrincipal(r.h.db, { id: ALICE }, async (tx) => {
			await tx.sql`delete from listened_sources where owner = ${ALICE}`;
			await tx.sql`delete from source_offers where owner = ${ALICE}`;
			await tx.sql`update pending_calls set status = 'expired' where owner = ${ALICE}
				and (status = 'open' or (status = 'approved' and replayed_at is null))`;
		});
	});

	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('offers me, after my brief and on a line of its own, the first application I never chose for, and on my yes has my assistant listen and read there', async () => {
		// She had her assistant listen to her mail: her drive is the first she never chose for
		await choose('mail', true);
		// Monday 12 October at eight in Paris: her brief, then the source offer, marked as a question
		const monday = await briefOf('2026-10-12T06:00:00Z');
		expect(monday.body).toBe(`${WRITTEN}\n\n${sourceOffer('Twake Drive')}`);
		const offered = await r.requestAskedIn(monday.eventId, 'drive');
		expect(
			logged({ msg: 'brief offered a source', pendingCallId: offered.id, source: 'drive' })
		).toBe(true);
		// She says yes at nine, which the harness answers itself, starting no turn
		clock.set('2026-10-12T07:00:00Z');
		const turns = r.h.apisix.llm.calls.length;
		await told(() => r.client.sendText(room, 'oui'), LISTENING_TO_DRIVE);
		expect(r.h.apisix.llm.calls.slice(turns)).toEqual([]);
		expect(await listened()).toEqual(['calendar', 'tasks', 'mail', 'drive']);
		expect(await allowed()).toContain('drive');
		expect(await choices()).toMatchObject({ mail: 'listening', drive: 'listening' });
		expect(
			logged({
				msg: 'listened source set',
				pendingCallId: offered.id,
				source: 'drive',
				listening: true
			})
		).toBe(true);
		// Tuesday, her brief offers nothing more
		const tuesday = await briefOf('2026-10-13T06:00:00Z');
		expect(tuesday.body).toBe(WRITTEN);
		expect(isQuestion(tuesday)).toBe(false);
	});

	it('offers one application a brief, in the order of its registry, none while another question waits for my answer, and never again one a newer question replaced', async () => {
		// Wednesday 14 October: her mail first, as the registry orders them
		const wednesday = await briefOf('2026-10-14T06:00:00Z');
		expect(wednesday.body).toBe(`${WRITTEN}\n\n${sourceOffer('Twake Mail')}`);
		await r.requestAskedIn(wednesday.eventId, 'mail');
		// She asks her assistant to listen to her drive, which asks her first for its read: the newer
		// question replaces the source offer
		await askToListenToDrive();
		expect((await r.callsTo('mail')).at(-1)?.status).toBe('superseded');
		// Thursday, her brief offers nothing while that question waits
		const thursday = await briefOf('2026-10-15T06:00:00Z');
		expect(thursday.body).toBe(WRITTEN);
		expect(isQuestion(thursday)).toBe(false);
		// She says no to it, which chooses nothing for her drive
		await told(() => r.client.sendText(room, 'non'), REFUSED);
		// Friday, her brief offers her drive, and her mail no more
		const friday = await briefOf('2026-10-16T06:00:00Z');
		expect(friday.body).toBe(`${WRITTEN}\n\n${sourceOffer('Twake Drive')}`);
		await r.requestAskedIn(friday.eventId, 'drive');
		expect(await choices()).toMatchObject({ mail: 'none', drive: 'none' });
	});

	it('keeps my no to a source offer as my choice not to listen there, and makes it no more', async () => {
		await choose('mail', true);
		// Monday 19 October
		const monday = await briefOf('2026-10-19T06:00:00Z');
		expect(monday.body).toBe(`${WRITTEN}\n\n${sourceOffer('Twake Drive')}`);
		await told(() => r.client.sendText(room, 'non'), REFUSED);
		expect(await choices()).toMatchObject({ mail: 'listening', drive: 'stopped' });
		expect(await listened()).toEqual(['calendar', 'tasks', 'mail']);
		expect(await allowed()).not.toContain('drive');
		// Tuesday, nothing
		const tuesday = await briefOf('2026-10-20T06:00:00Z');
		expect(tuesday.body).toBe(WRITTEN);
		expect(isQuestion(tuesday)).toBe(false);
	});

	it('takes my answers to a source offer through the API as it takes them in my room', async () => {
		await choose('mail', true);
		// Wednesday 21 October, she refuses the source offer through the API
		const wednesday = await briefOf('2026-10-21T06:00:00Z');
		const refusedOffer = await r.requestAskedIn(wednesday.eventId, 'drive');
		await told(async () => {
			const refused = await r.h.api.post(ALICE, `/v1/pending-calls/${refusedOffer.id}/refuse`, {});
			expect(refused.status).toBe(200);
		}, REFUSED);
		expect((await choices()).drive).toBe('stopped');
		// Offered her drive again, she allows it through the API
		await withPrincipal(r.h.db, { id: ALICE }, async (tx) => {
			await tx.sql`delete from listened_sources where owner = ${ALICE} and source = 'drive'`;
			await tx.sql`delete from source_offers where owner = ${ALICE}`;
		});
		const thursday = await briefOf('2026-10-22T06:00:00Z');
		const allowedOffer = await r.requestAskedIn(thursday.eventId, 'drive');
		await told(async () => {
			const approved = await r.h.api.post(
				ALICE,
				`/v1/pending-calls/${allowedOffer.id}/approve`,
				{}
			);
			expect(approved.status).toBe(202);
		}, LISTENING_TO_DRIVE);
		expect((await choices()).drive).toBe('listening');
		expect(await allowed()).toContain('drive');
	});

	it('offers nothing for an application I chose for, listening there or not, nor for one my assistant listens to by default', async () => {
		await choose('mail', true);
		await choose('drive', false);
		// Friday 23 October: her calendar, offered too, is listened to already
		const friday = await briefOf('2026-10-23T06:00:00Z');
		expect(friday.body).toBe(WRITTEN);
		expect(isQuestion(friday)).toBe(false);
	});

	it('keeps the question of my first brief in its place, and offers after the brief my yes to it sends', async () => {
		await choose('mail', true);
		for (const domain of BRIEF_DOMAINS) await withdrawConsent(r.h.db, ALICE, domain, 'read');
		await withPrincipal(
			r.h.db,
			{ id: ALICE },
			(tx) => tx.sql`update owner_settings set brief_reads_settled = false where owner = ${ALICE}`
		);
		// Monday 26 October at eight, in winter time: the question of her first brief, which offers
		// nothing
		const seen = said().length;
		await pass('2026-10-26T07:00:00Z');
		const question = await nextOf(seen, 'the question of her first brief', isQuestion);
		await r.requestAskedIn(question.eventId, 'brief');
		expect(question.body).not.toContain(sourceOffer('Twake Drive'));
		// Her yes sends that day's brief, and the source offer after it
		const answered = said().length;
		await r.client.sendText(room, 'oui');
		const brief = await nextOf(answered, 'the brief her yes sent', isBrief);
		expect(brief.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-10-26' });
		expect(brief.body).toBe(`${WRITTEN}\n\n${sourceOffer('Twake Drive')}`);
		await r.requestAskedIn(brief.eventId, 'drive');
	});

	it('offers nothing after the brief I ask for in my turn, which answers me', async () => {
		await choose('mail', true);
		// Tuesday 27 October at ten
		clock.set('2026-10-27T09:00:00Z');
		const seen = said().length;
		await r.client.sendText(room, 'Mon brief ?');
		const brief = await nextOf(seen, 'the brief she asked for', isBrief);
		expect(brief.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-10-27' });
		expect(brief.body).toBe(WRITTEN);
		expect(isQuestion(brief)).toBe(false);
	});

	it('makes a source offer past a question I left unanswered beyond its lifetime, and never makes again one I left so', async () => {
		// Thursday 29 October in the evening, she asks her assistant to listen to her drive, then leaves
		// its question unanswered past its lifetime
		clock.set('2026-10-29T17:00:00Z');
		await askToListenToDrive();
		await pastLifetime('drive');
		// Friday at eight: her brief offers her mail, as the registry orders them
		const friday = await briefOf('2026-10-30T07:00:00Z');
		expect(friday.body).toBe(`${WRITTEN}\n\n${sourceOffer('Twake Mail')}`);
		await r.requestAskedIn(friday.eventId, 'mail');
		// She leaves that source offer unanswered past its lifetime too: Monday, her brief offers her
		// drive, and her mail no more
		await pastLifetime('mail');
		const monday = await briefOf('2026-11-02T07:00:00Z');
		expect(monday.body).toBe(`${WRITTEN}\n\n${sourceOffer('Twake Drive')}`);
		await r.requestAskedIn(monday.eventId, 'drive');
		expect(await choices()).toMatchObject({ mail: 'none', drive: 'none' });
	});

	it('makes its source offer after the brief that closes the question about my permission an earlier brief gave way to', async () => {
		await choose('mail', true);
		// Tuesday 3 November at eight, the platform holds no permission of hers: the question about it,
		// in place of her brief, and no source offer
		broker = brokerRefusal('delegation_missing');
		const seen = said().length;
		await pass('2026-11-03T07:00:00Z');
		const question = await nextOf(seen, 'the question about her permission', isQuestion);
		expect(isBrief(question)).toBe(false);
		expect(question.body).not.toContain(sourceOffer('Twake Drive'));
		await r.requestAskedIn(question.eventId, 'calendar');
		// Wednesday, it holds one again: her brief, which closes that question unanswered, and its
		// source offer
		broker = null;
		const wednesday = await briefOf('2026-11-04T07:00:00Z');
		expect(wednesday.body).toBe(`${WRITTEN}\n\n${sourceOffer('Twake Drive')}`);
		await r.requestAskedIn(wednesday.eventId, 'drive');
		expect((await r.callsTo('calendar')).at(-1)?.status).toBe('expired');
	});

	it('makes no source offer while my yes to another question of my room waits to run, which its question would supersede', async () => {
		await choose('mail', true);
		// Wednesday 4 November in the evening, she asks her assistant to listen to her drive, and says
		// yes to its question, which admission holds: her yes waits to run
		clock.set('2026-11-04T17:00:00Z');
		await askToListenToDrive();
		await withPrincipal(
			r.h.db,
			{ id: ALICE },
			(tx) => tx.sql`update pending_calls set status = 'approved', decided_at = now()
				where owner = ${ALICE} and domain = 'drive' and status = 'open'`
		);
		// Thursday, her brief offers nothing, and her yes still waits
		const thursday = await briefOf('2026-11-05T07:00:00Z');
		expect(thursday.body).toBe(WRITTEN);
		expect(isQuestion(thursday)).toBe(false);
		expect((await r.callsTo('drive')).at(-1)?.status).toBe('approved');
	});

	it('forgets the source offers it made once I delete my assistant: the one I create next makes them again', async () => {
		await choose('mail', true);
		// Monday 9 November, Jarvis offers her drive, which she leaves unanswered
		const monday = await briefOf('2026-11-09T07:00:00Z');
		expect(monday.body).toBe(`${WRITTEN}\n\n${sourceOffer('Twake Drive')}`);
		// At ten, she deletes Jarvis and creates Iris, whose reads she allows
		clock.set('2026-11-09T09:00:00Z');
		await answerTo('/delete', 'Supprimer Jarvis ?');
		await answerTo('oui', 'Ton assistant est supprimé.');
		await answerTo('/newbot', 'Quel nom veux-tu lui donner ?');
		await answerTo('Iris', `C'est fait : Iris est ${r.assistantId}`);
		const mine = await r.h.api.get<{ roomId: string }>(ALICE, '/v1/assistants/me');
		expect(mine.body.roomId).not.toBe(room);
		room = mine.body.roomId;
		await r.client.joinRoom(room);
		await r.client.waitForMessage(room, r.assistantId, (t) => t.includes('Iris'));
		await seenEveryDay(r.h.db, ALICE);
		for (const domain of BRIEF_DOMAINS) await grantConsent(r.h.db, ALICE, domain, 'read');
		// Tuesday, Iris's first brief offers her drive again, in Iris's room, whose source offer waits
		// for her answer
		const tuesday = await briefOf('2026-11-10T07:00:00Z');
		expect(tuesday.body).toBe(`${WRITTEN}\n\n${sourceOffer('Twake Drive')}`);
		expect(isQuestion(tuesday)).toBe(true);
		expect((await r.callsTo('drive')).map((c) => c.status)).toEqual(['open']);
	});
});
