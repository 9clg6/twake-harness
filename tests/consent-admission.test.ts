import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeClient } from './helpers/client.js';
import { makeSettableClock } from './helpers/clock.js';
import {
	modelFor,
	modelUsing,
	QUESTION_CONTENT_KEY,
	readCatalog,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import { lastUserContent, type LlmScript } from './helpers/fake-apisix.js';
import { eventually } from './helpers/feedback.js';

// What my assistant tells me when admission refuses a message of mine for my turns at once
const TOO_MANY = 'I received too many messages at once';

// What my assistant tells me when admission kept it too long from doing what I allowed
const HELD_TOO_LONG =
	'Too many requests came in at once for me to do it in time, so I have not done it yet. Your request stays open: answer yes in your next message and I will try again.';

// What my assistant tells me of a request a newer one replaced
const SUPERSEDED = 'A newer request replaced this one, so I did nothing. Answer the latest one.';

// How my assistant asks me in French before it first reads my data in an application
const FRENCH_QUESTION = "C'est la première fois";

// What my assistant tells me in French when my limit for the day kept it from doing what I allowed
const OPEN_UNTIL_MIDNIGHT =
	"J'ai atteint ma limite du jour, je ne l'ai donc pas encore fait. Ta demande reste ouverte : après minuit, réponds oui dans ton prochain message et je le ferai.";

// The same, when my request ends before my limit lifts
const ENDS_BEFORE_MIDNIGHT =
	"J'ai atteint ma limite du jour, je ne l'ai donc pas fait, et cette demande expire avant que ma limite se lève à minuit. Redemande-moi après minuit si tu en as encore besoin.";

// What my assistant tells me in French when I answer a request past its end
const EXPIRED =
	"Cette demande a expiré, je n'ai donc rien fait. Redemande-moi si tu en as encore besoin.";

// The requests that wait for my answer, as the API shows my clients
async function waitingRequests(r: ConsentRoom): Promise<unknown[]> {
	const waiting = await r.h.api.get<{ pending_calls: unknown[] }>(
		'alice@test.local',
		'/v1/pending-calls'
	);
	expect(waiting.status).toBe(200);
	return waiting.body.pending_calls;
}

// The message of my assistant after the first `seen` ones that start with a prefix
async function nextMessage(
	r: ConsentRoom,
	prefix: string,
	seen: number
): Promise<DecryptedMessage> {
	await r.nextSaying(prefix, seen);
	const message = r.saying(prefix).at(seen);
	if (message === undefined) throw new Error(`no message starting with ${prefix}`);
	return message;
}

// The model searches my mail for the budget, then tells what it found
const MAIL_MODEL = modelUsing('search_mail', { q: 'budget' });

// A room where my assistant may read my mail once I allow it, which finds what it is asked
async function startMailRoom(
	env: Record<string, string>,
	clock?: ReturnType<typeof makeSettableClock>
): Promise<ConsentRoom> {
	const r = await startConsentRoom(env, clock === undefined ? {} : { clock });
	r.h.apisix.contracts.spec = readCatalog(['mail', 'drive']);
	for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(2);
	r.h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
	r.h.apisix.llm.script = MAIL_MODEL;
	return r;
}

// What I ask my assistant through the API on every replica while I answer in my room
const HELD = 'Take your time';

// My assistant works for me through the API on every replica, its model held, while the model
// answers anything else as the script says: until released, every other turn of mine is refused
// for a full queue. Resolves to the release, which waits for those turns to answer.
async function busyEverywhere(r: ConsentRoom, script: LlmScript): Promise<() => Promise<void>> {
	let release: () => void = () => undefined;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let working = 0;
	r.h.apisix.llm.script = (request, index) => {
		if (lastUserContent(request) !== HELD) return script(request, index);
		working += 1;
		return { content: 'Done', hold: released };
	};
	const chats = Promise.all(
		r.h.apps.map((app) =>
			makeClient({ app, apps: [app], issuer: r.h.issuer }).post('alice@test.local', '/v1/chat', {
				message: HELD
			})
		)
	);
	expect(await eventually(() => working === r.h.apps.length)).toBe(true);
	return async () => {
		release();
		expect((await chats).every((chat) => chat.status === 200)).toBe(true);
	};
}

// What the harness logged, as its operator reads it
function logged(r: ConsentRoom, msg: string): Record<string, unknown>[] {
	return r.h.logLines().filter((line) => line['msg'] === msg);
}

// An event of my room as the homeserver holds it, encrypted
async function encryptedEvent(r: ConsentRoom, eventId: string): Promise<Record<string, unknown>> {
	const reply = await r.h.synapse.request(
		r.alice,
		'GET',
		`/_matrix/client/v3/rooms/${encodeURIComponent(r.room)}/event/${encodeURIComponent(eventId)}`
	);
	return reply.body;
}

// Pushes events to the matrix role as the homeserver does, in a transaction of their own
async function push(r: ConsentRoom, events: Record<string, unknown>[]): Promise<number> {
	const reply = await fetch(
		`http://127.0.0.1:${r.h.port}/_matrix/app/v1/transactions/test-${Date.now()}-${Math.random()}`,
		{
			method: 'PUT',
			headers: { authorization: `Bearer ${r.h.hsToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ events })
		}
	);
	return reply.status;
}

describe('my yes while my assistant is busy', () => {
	let r: ConsentRoom;
	beforeAll(async () => {
		// One turn of mine at a time, none waiting behind it, and six seconds for the turn my yes
		// resumes to get through admission
		r = await startMailRoom({
			ADMISSION_USER_QUEUE: '0',
			ADMISSION_USER_PER_MINUTE: '100',
			TURN_EVENT_MAX_DELAY_MS: '6000'
		});
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('runs the call I allowed once it has room, and never tells me it is busy', async () => {
		r.h.apisix.llm.script = MAIL_MODEL;
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Find the budget in my mail');
		await r.nextQuestion(seen);
		const release = await busyEverywhere(r, MAIL_MODEL);
		const found = r.saying('Found:').length;
		try {
			await r.client.sendText(r.room, 'yes');
			// Refused for now, my yes waits for room
			const deferred = await eventually(() => logged(r, 'resumed turn deferred')[0]);
			expect(deferred).toMatchObject({ reason: 'user_queue_full' });
			expect(r.h.apisix.contracts.calls).toHaveLength(0);
		} finally {
			await release();
		}
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/mail/items');
		expect(r.h.apisix.contracts.calls.map((c) => c.query)).toEqual([{ q: 'budget' }]);
		expect(r.saying(TOO_MANY)).toHaveLength(0);
	});

	it('asks me again once it waited too long for room, and does it on my next yes', async () => {
		const model = modelUsing('search_drive', { q: 'budget' });
		r.h.apisix.llm.script = model;
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Find the budget in my drive');
		const question = await r.nextQuestion(seen);
		const release = await busyEverywhere(r, model);
		try {
			await r.client.sendText(r.room, 'yes');
			const notice = await nextMessage(r, HELD_TOO_LONG, 0);
			// The notice asks about the same request, which waits for my answer until the same end
			expect(notice.content[QUESTION_CONTENT_KEY]).toEqual(
				r.questions().find((m) => m.eventId === question)?.content[QUESTION_CONTENT_KEY]
			);
			await r.requestAskedIn(notice.eventId, 'drive');
			expect(r.h.apisix.contracts.calls.filter((c) => c.path.includes('/drive/'))).toEqual([]);
		} finally {
			await release();
		}
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'yes');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/drive/items');
		expect(r.h.apisix.contracts.calls.filter((c) => c.path.includes('/drive/'))).toHaveLength(1);
		expect(r.saying(TOO_MANY)).toHaveLength(0);
	});
});

describe('my yes held while my assistant asks me something newer', () => {
	let r: ConsentRoom;
	beforeAll(async () => {
		// Two turns of mine a minute, and a second for the turn my yes resumes to get through
		// admission
		r = await startMailRoom({ ADMISSION_USER_PER_MINUTE: '2', TURN_EVENT_MAX_DELAY_MS: '1000' });
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	// The question about my mail, once my assistant asked it
	let mail = '';

	it('closes the request my yes answered, the newer one staying the one to answer', async () => {
		// My second request is held at the model until released: my yes to the first waits behind it
		const model = modelFor({
			'Find the budget in my drive': { tool: 'search_drive', args: { q: 'budget' } },
			'Find the budget in my mail': { tool: 'search_mail', args: { q: 'budget' } }
		});
		let release: () => void = () => undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let working = false;
		r.h.apisix.llm.script = (request) => {
			if (lastUserContent(request) !== 'Find the budget in my mail') return model(request);
			working = true;
			return { ...model(request), hold: released };
		};
		await r.client.sendText(r.room, 'Find the budget in my drive');
		const drive = await r.nextQuestion(0);
		await r.client.sendText(r.room, 'Find the budget in my mail');
		expect(await eventually(() => working)).toBe(true);
		await r.client.react(r.room, drive, '✅');
		expect(await eventually(async () => (await waitingRequests(r)).length === 0)).toBe(true);
		release();
		mail = await r.nextQuestion(1);
		// My two turns of the minute spent, my yes waits, gives up, and finds a newer request open
		const notice = await nextMessage(r, SUPERSEDED, 0);
		expect(notice.content).not.toHaveProperty([QUESTION_CONTENT_KEY]);
		expect(logged(r, 'resumed turn deferred')[0]).toMatchObject({ reason: 'user_rate' });
		const waiting = await r.requestAskedIn(mail, 'mail');
		expect(await waitingRequests(r)).toEqual([expect.objectContaining({ id: waiting.id })]);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it('then asks me again about the newer request once my yes to it waits too long', async () => {
		await r.client.sendText(r.room, 'yes');
		const notice = await nextMessage(r, HELD_TOO_LONG, 0);
		expect(notice.content[QUESTION_CONTENT_KEY]).toEqual(
			r.questions().find((m) => m.eventId === mail)?.content[QUESTION_CONTENT_KEY]
		);
		await r.requestAskedIn(notice.eventId, 'mail');
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});
});

describe('my yes once my assistant reached its limit for the day, in Europe/Paris', () => {
	const clock = makeSettableClock('2026-10-08T21:30:00Z');
	let r: ConsentRoom;
	beforeAll(async () => {
		// A day of one turn, and no wait between my turns
		r = await startMailRoom(
			{
				ASSISTANT_LOCALE: 'fr',
				ASSISTANT_TIMEZONE: 'Europe/Paris',
				ADMISSION_USER_DAILY_TOKENS: '1',
				ADMISSION_USER_PER_MINUTE: '100'
			},
			clock
		);
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('keeps my request open, says so on it, and does it on my yes after midnight', async () => {
		// 23:30 in Paris: the turn that asks me spends my day
		clock.set('2026-10-08T21:30:00Z');
		await r.client.sendText(r.room, 'Trouve le budget dans mes mails');
		const question = await nextMessage(r, FRENCH_QUESTION, 0);
		await r.client.sendText(r.room, 'oui');
		const notice = await nextMessage(r, OPEN_UNTIL_MIDNIGHT, 0);
		// The notice asks about the same request, which waits for my answer until the same end
		expect(notice.content[QUESTION_CONTENT_KEY]).toEqual(question.content[QUESTION_CONTENT_KEY]);
		await r.requestAskedIn(notice.eventId, 'mail');
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
		// Before midnight, my yes gets the same answer
		clock.set('2026-10-08T21:50:00Z');
		await r.client.sendText(r.room, 'oui');
		await nextMessage(r, OPEN_UNTIL_MIDNIGHT, 1);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
		// After midnight, my yes does it
		clock.set('2026-10-08T22:05:00Z');
		await r.client.sendText(r.room, 'oui');
		expect(await r.nextSaying('Found:', 0)).toContain('/contracts/v1/mail/items');
		expect(r.h.apisix.contracts.calls.map((c) => c.query)).toEqual([{ q: 'budget' }]);
	});

	it('takes the yes it kept, delivered again after midnight, for no answer', async () => {
		// 23:30 in Paris, on a day of its own: the turn that asks me spends it
		clock.set('2026-10-10T21:30:00Z');
		r.h.apisix.llm.script = modelUsing('search_drive', { q: 'budget' });
		const asked = r.saying(FRENCH_QUESTION).length;
		await r.client.sendText(r.room, 'Trouve le budget dans mon drive');
		await nextMessage(r, FRENCH_QUESTION, asked);
		const held = r.saying(OPEN_UNTIL_MIDNIGHT).length;
		const yes = await r.client.sendText(r.room, 'oui');
		const notice = await nextMessage(r, OPEN_UNTIL_MIDNIGHT, held);
		// After midnight, the homeserver delivers that yes again
		clock.set('2026-10-10T22:05:00Z');
		expect(await push(r, [await encryptedEvent(r, yes)])).toBe(200);
		expect(
			await eventually(() =>
				logged(r, 'answer delivered again').find((line) => line['eventId'] === yes)
			)
		).toMatchObject({ eventId: yes });
		// My request still waits for my answer
		await r.requestAskedIn(notice.eventId, 'drive');
		expect(r.h.apisix.contracts.calls.filter((c) => c.path.includes('/drive/'))).toEqual([]);
		// My own yes does it
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'oui');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/drive/items');
		expect(r.h.apisix.contracts.calls.filter((c) => c.path.includes('/drive/'))).toHaveLength(1);
	});
});

describe('my yes once my assistant reached its limit for the day, on requests of twenty seconds', () => {
	const clock = makeSettableClock('2026-10-10T08:00:00Z');
	let r: ConsentRoom;
	beforeAll(async () => {
		// A day of one turn in Paris, and twenty seconds to answer a request
		r = await startMailRoom(
			{
				ASSISTANT_LOCALE: 'fr',
				ASSISTANT_TIMEZONE: 'Europe/Paris',
				ADMISSION_USER_DAILY_TOKENS: '1',
				ADMISSION_USER_PER_MINUTE: '100',
				CONSENT_REQUEST_LIFETIME_MS: '20000'
			},
			clock
		);
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('tells me my request ends before my limit lifts, and does nothing', async () => {
		// 10:00 in Paris, on a day of its own: the turn that asks me spends it
		clock.set('2026-10-10T08:00:00Z');
		const asked = r.saying(FRENCH_QUESTION).length;
		await r.client.sendText(r.room, 'Trouve le budget dans mes mails');
		await nextMessage(r, FRENCH_QUESTION, asked);
		await r.client.sendText(r.room, 'oui');
		const notice = await nextMessage(r, ENDS_BEFORE_MIDNIGHT, 0);
		// Nothing is left to answer
		expect(notice.content).not.toHaveProperty([QUESTION_CONTENT_KEY]);
		expect(await waitingRequests(r)).toEqual([]);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it('closes my request at its end once it waits for my answer again', async () => {
		// Five seconds before midnight in Paris, on a day of its own: the turn that asks me spends it
		clock.set('2026-10-11T21:59:55Z');
		const asked = r.saying(FRENCH_QUESTION).length;
		await r.client.sendText(r.room, 'Trouve le budget dans mes mails');
		const question = await nextMessage(r, FRENCH_QUESTION, asked);
		await r.client.sendText(r.room, 'oui');
		const notice = await nextMessage(r, OPEN_UNTIL_MIDNIGHT, 0);
		const marker = notice.content[QUESTION_CONTENT_KEY] as { id: string; expires_ts: number };
		expect(marker).toEqual(question.content[QUESTION_CONTENT_KEY]);
		// Past the end the question gave, and past midnight, my yes does nothing, and I am told why
		await new Promise((resolve) => setTimeout(resolve, marker.expires_ts + 1000 - Date.now()));
		clock.set('2026-10-11T22:05:00Z');
		const expired = r.saying(EXPIRED).length;
		await r.client.sendText(r.room, 'oui');
		await nextMessage(r, EXPIRED, expired);
		expect(await waitingRequests(r)).toEqual([]);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});
});
