import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withPrincipal } from '../src/db/client.js';
import { call, readCatalog, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import type { ChatRequest, ScriptedReply } from './helpers/fake-apisix.js';
import {
	eventually,
	inReplyTo,
	watchFeedback,
	type RoomFeedback,
	type ShownMessage
} from './helpers/feedback.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The status texts in English, the language of the deployment, which Alice never changed
const WORKING = '⏳ On it…';
const DONE = '✅ Done';
const NOT_DONE = '❌ Not done';
const ASKING = 'I need your answer to go on: see below.';
const LATE = 'This is taking longer than expected. If no answer follows, ask me again.';
const FAILED = 'Something went wrong on my side. Please try again in a moment.';
const BUSY = 'I am busy right now and cannot take this message. Please send it again in a moment.';

// The delay the deployment gives a turn before its status shows, the default
const STATUS_DELAY_MS = 3000;
// How long a status waits for its turn's answer before it gives up, short enough to be seen here,
// long enough for every other turn of the suite to answer before
const STATUS_MAX_MS = 15_000;

// The relation an event a call sends carries in clear, as the gateway sees it, or null
function relationOf(body: unknown): Record<string, unknown> | null {
	if (typeof body !== 'object' || body === null) return null;
	const relation = (body as Record<string, unknown>)['m.relates_to'];
	return typeof relation === 'object' && relation !== null
		? (relation as Record<string, unknown>)
		: null;
}

// Whether a call sends an event of the room, encrypted as every event of Alice's room is
function sendsEvent(call: { readonly method: string; readonly path: string }): boolean {
	return call.method === 'PUT' && call.path.includes('/send/m.room.encrypted/');
}

describe('a status message while my assistant works on a message', () => {
	let r: ConsentRoom;
	let feedback: RoomFeedback;
	beforeAll(async () => {
		r = await startConsentRoom(
			{ TURN_STATUS_DELAY_MS: String(STATUS_DELAY_MS), ADMISSION_USER_PER_MINUTE: '100' },
			{ statusMaxMs: STATUS_MAX_MS }
		);
		r.h.apisix.contracts.spec = readCatalog(['drive', 'notes']);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(2);
		feedback = watchFeedback({
			synapse: r.h.synapse,
			owner: r.alice,
			client: r.client,
			room: r.room,
			assistantId: r.assistantId
		});
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	// The assistant's message that replies to an event, as Alice's client shows it
	function replyTo(eventId: string): ShownMessage | undefined {
		return feedback.shown().find((m) => inReplyTo(m.original) === eventId);
	}

	// The status of the turn that answers an event, once Alice's client shows it
	function statusShown(eventId: () => string): Promise<unknown> {
		return eventually(() => replyTo(eventId()) !== undefined, 20_000);
	}

	// The reply to an event once it says what is expected
	function replySaying(
		eventId: string,
		body: string,
		timeoutMs = 30_000
	): Promise<ShownMessage | undefined> {
		return eventually(() => {
			const shown = replyTo(eventId);
			return shown?.body === body ? shown : undefined;
		}, timeoutMs);
	}

	// The assistant's messages Alice's client shows after the first `count` ones
	function shownSince(count: number): ShownMessage[] {
		return feedback.shown().slice(count);
	}

	function shows(body: string, timeoutMs = 15_000): Promise<boolean> {
		return eventually(() => feedback.shown().some((m) => m.body === body), timeoutMs);
	}

	// What a message said, from the first to the last edit
	function saidBy(message: ShownMessage | undefined): unknown[] {
		return message === undefined
			? []
			: [message.original['body'], ...message.edits.map((e) => e.content['body'])];
	}

	// The events Synapse notified Alice of, as her phone would be by a push
	async function notified(): Promise<string[]> {
		const response = await r.h.synapse.request(
			r.alice,
			'GET',
			'/_matrix/client/v3/notifications?limit=100'
		);
		const notifications = response.body['notifications'] as
			{ readonly event?: { readonly event_id?: string } }[] | undefined;
		return (notifications ?? []).map((n) => n.event?.event_id ?? '');
	}

	// The tokens Alice spent today, as admission counts them: past her daily budget, her turns are
	// refused
	async function spendToday(tokens: number): Promise<void> {
		const owner = 'alice@test.local';
		const day = new Date().toISOString().slice(0, 10);
		await withPrincipal(
			r.h.db,
			{ id: owner },
			(tx) => tx.sql`
				insert into usage_daily (owner, day, tokens) values (${owner}, ${day}, ${tokens})
				on conflict (owner, day) do update set tokens = excluded.tokens`
		);
	}

	// An event of the room as the homeserver keeps it
	async function stored(eventId: string): Promise<Record<string, unknown>> {
		const response = await r.h.synapse.request(
			r.alice,
			'GET',
			`/_matrix/client/v3/rooms/${encodeURIComponent(r.room)}/event/${encodeURIComponent(eventId)}`
		);
		return response.body;
	}

	// The id of the eyes the assistant put on an event, or an empty string when there are none
	function eyesOn(eventId: string): string {
		return feedback.reactionsOn(eventId).find((x) => x.key === '👀')?.eventId ?? '';
	}

	it('posts a status when my message takes a while, closed once the answer went out on its own', async () => {
		let asked = '';
		const answer = 'Here is **the** answer';
		r.h.apisix.llm.script = () => ({ content: answer, hold: statusShown(() => asked) });
		const before = feedback.shown().length;
		asked = await r.client.sendText(r.room, 'Take your time');
		const status = await replySaying(asked, DONE);
		expect(saidBy(status)).toEqual([WORKING, DONE]);
		// The answer follows the status, a message of its own as it would have been without one
		const [, reply] = shownSince(before);
		expect(shownSince(before).map((m) => m.body)).toEqual([DONE, answer]);
		expect(reply?.content).toEqual({
			msgtype: 'm.text',
			body: answer,
			format: 'org.matrix.custom.html',
			formatted_body: 'Here is <strong>the</strong> answer'
		});
		expect(reply?.edits).toEqual([]);
		expect(inReplyTo(reply?.original ?? {})).toBeNull();
		// Synapse notifies me of the answer, never of an edit
		const closing = status?.edits.at(-1);
		const events = await notified();
		expect(events).toContain(reply?.eventId);
		expect(events).not.toContain(closing?.eventId);
		// The status and its edit stay encrypted on the homeserver, which relates the edit to the
		// status, as the relation travels in clear: a client that loads the room later is told of it
		const original = await stored(status?.eventId ?? '');
		expect(original['type']).toBe('m.room.encrypted');
		const relations = (original['unsigned'] as Record<string, unknown> | undefined)?.[
			'm.relations'
		] as Record<string, unknown> | undefined;
		expect(relations?.['m.replace']).toMatchObject({ event_id: closing?.eventId });
		const edit = await stored(closing?.eventId ?? '');
		expect(edit['type']).toBe('m.room.encrypted');
		expect(edit['content']).toMatchObject({
			'm.relates_to': { rel_type: 'm.replace', event_id: status?.eventId }
		});
		// The eyes go from my message once it is answered, and the check mark comes
		const eyes = feedback.reactionsOn(asked).find((x) => x.key === '👀');
		expect(eyes).toBeDefined();
		expect(await eventually(() => feedback.isRedacted(eyes?.eventId ?? ''))).toBe(true);
		const check = await eventually(() => feedback.reactionsOn(asked).find((x) => x.key === '✅'));
		expect(check).toBeDefined();
	});

	it('posts no status for a message answered before it was due, however long typing takes to stop', async () => {
		let sentAt = 0;
		let slowTyping = false;
		r.h.apisix.llm.script = () => ({
			content: 'Answered just in time',
			hold: (async () => {
				await sleep(Math.max(0, sentAt + STATUS_DELAY_MS - 1000 - Date.now()));
				slowTyping = true;
			})()
		});
		// The assistant stops typing once the answer is ready, past the moment its status was due
		r.h.apisix.matrixHold = (c) => {
			if (!slowTyping || c.method !== 'PUT' || !c.path.includes('/typing/')) return null;
			slowTyping = false;
			return sleep(2000);
		};
		try {
			const before = feedback.shown().length;
			sentAt = Date.now();
			const asked = await r.client.sendText(r.room, 'Just in time');
			expect(await shows('Answered just in time')).toBe(true);
			await sleep(Math.max(0, sentAt + STATUS_DELAY_MS + 2000 - Date.now()));
			expect(shownSince(before).map((m) => m.body)).toEqual(['Answered just in time']);
			expect(replyTo(asked)).toBeUndefined();
		} finally {
			r.h.apisix.matrixHold = null;
		}
	});

	it('closes the status of an answer that goes out as its bound passes on the answer', async () => {
		let sentAt = 0;
		let slowAnswer = false;
		r.h.apisix.llm.script = () => ({
			content: 'An answer at the bound',
			hold: (async () => {
				await sleep(Math.max(0, sentAt + STATUS_MAX_MS - 1500 - Date.now()));
				slowAnswer = true;
			})()
		});
		// The answer, the one event the room gets with no relation, takes its time to go out
		r.h.apisix.matrixHold = (c) => {
			if (!slowAnswer || !sendsEvent(c) || relationOf(c.body) !== null) return null;
			slowAnswer = false;
			return sleep(3000);
		};
		try {
			const before = feedback.shown().length;
			sentAt = Date.now();
			const asked = await r.client.sendText(r.room, 'Answer at the last moment');
			const status = await replySaying(asked, DONE, STATUS_MAX_MS + 15_000);
			expect(saidBy(status)).toEqual([WORKING, DONE]);
			expect(shownSince(before).map((m) => m.body)).toEqual([DONE, 'An answer at the bound']);
		} finally {
			r.h.apisix.matrixHold = null;
		}
	});

	it('closes its status even when the first closing edit fails', async () => {
		let asked = '';
		r.h.apisix.llm.script = () => ({
			content: 'Answered, then closed',
			hold: statusShown(() => asked)
		});
		// The first edit the status gets, its closing, fails once
		let failed = false;
		r.h.apisix.matrixFault = (c) => {
			if (failed || !sendsEvent(c) || relationOf(c.body)?.['rel_type'] !== 'm.replace') return null;
			failed = true;
			return 500;
		};
		try {
			asked = await r.client.sendText(r.room, 'Close it whatever happens');
			const status = await replySaying(asked, DONE);
			expect(failed).toBe(true);
			expect(saidBy(status)).toEqual([WORKING, DONE]);
		} finally {
			r.h.apisix.matrixFault = null;
		}
	});

	it('posts no status when my message is answered at once', async () => {
		// A turn that runs a tool, as quickly as the rest
		r.h.apisix.llm.script = (request: ChatRequest): ScriptedReply =>
			request.messages.at(-1)?.role === 'tool'
				? { content: 'Fast answer' }
				: { toolCalls: call('consents_list', {}) };
		const before = feedback.shown().length;
		const sentAt = Date.now();
		const asked = await r.client.sendText(r.room, 'Quick one');
		expect(await shows('Fast answer')).toBe(true);
		// Past the moment its status would have shown
		await sleep(Math.max(0, sentAt + STATUS_DELAY_MS + 2000 - Date.now()));
		const after = shownSince(before);
		expect(after.map((m) => m.body)).toEqual(['Fast answer']);
		expect(after[0]?.edits).toEqual([]);
		expect(inReplyTo(after[0]?.original ?? {})).toBeNull();
		const check = await eventually(() => feedback.reactionsOn(asked).find((x) => x.key === '✅'));
		expect(check).toBeDefined();
	});

	it('closes the status of a failed turn, its notice following on its own', async () => {
		let asked = '';
		r.h.apisix.llm.script = () => ({ content: null, hold: statusShown(() => asked) });
		const before = feedback.shown().length;
		asked = await r.client.sendText(r.room, 'Break, slowly');
		const status = await replySaying(asked, NOT_DONE);
		expect(saidBy(status)).toEqual([WORKING, NOT_DONE]);
		// The notice follows, a message of its own, which Synapse notifies me of
		expect(shownSince(before).map((m) => m.body)).toEqual([NOT_DONE, FAILED]);
		const notice = shownSince(before)[1];
		expect(inReplyTo(notice?.original ?? {})).toBeNull();
		expect(await notified()).toContain(notice?.eventId);
		// No check mark on a message that was not answered, as before
		expect(await eventually(() => feedback.isRedacted(eyesOn(asked)), 10_000)).toBe(true);
		expect(feedback.reactionsOn(asked).filter((x) => x.key === '✅')).toEqual([]);
	});

	it('closes the status of a refused turn, its notice following on its own', async () => {
		let second = '';
		// My second message waits for my first to be answered, long enough for its status to show; by
		// then I have spent my tokens for the day, and the second is refused
		r.h.apisix.llm.script = () => ({
			content: 'The first answer',
			hold: (async () => {
				await statusShown(() => second);
				await spendToday(1_000_000);
			})()
		});
		const before = feedback.shown().length;
		try {
			const first = await r.client.sendText(r.room, 'First, slowly');
			second = await r.client.sendText(r.room, 'Second, while you work');
			const status = await replySaying(second, NOT_DONE);
			expect(saidBy(status)).toEqual([WORKING, NOT_DONE]);
			expect(saidBy(await replySaying(first, DONE))).toEqual([WORKING, DONE]);
			// The notice follows, a message of its own, which Synapse notifies me of
			expect(await shows(BUSY)).toBe(true);
			const notice = shownSince(before).find((m) => m.body === BUSY);
			expect(inReplyTo(notice?.original ?? {})).toBeNull();
			expect(await notified()).toContain(notice?.eventId);
			expect(feedback.reactionsOn(second).filter((x) => x.key === '✅')).toEqual([]);
		} finally {
			await spendToday(0);
		}
	});

	it('posts a status on the turn my yes resumes, closed once its answer went out', async () => {
		let request = '';
		r.h.apisix.llm.script = (req: ChatRequest): ScriptedReply => {
			const last = req.messages.at(-1);
			return last?.role === 'tool'
				? { content: `Found: ${last.content ?? ''}`, hold: statusShown(() => request) }
				: { toolCalls: call('search_drive', { q: 'budget' }) };
		};
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Find my budget file');
		request = await r.nextQuestion(seen);
		const before = feedback.shown().length;
		await r.client.react(r.room, request, '✅');
		// My reaction carries no message of its own: the status replies to the request I answered
		const status = await replySaying(request, DONE);
		expect(saidBy(status)).toEqual([WORKING, DONE]);
		const answer = 'Found: {"status":200,"body":{"ok":true}}';
		expect(shownSince(before).map((m) => m.body)).toEqual([DONE, answer]);
		expect(shownSince(before)[1]?.content).toMatchObject({
			body: answer,
			format: 'org.matrix.custom.html'
		});
		const check = await eventually(() => feedback.reactionsOn(request).find((x) => x.key === '✅'));
		expect(check).toBeDefined();
	});

	it('keeps a question to me a message of its own, its status pointing to it', async () => {
		let asked = '';
		r.h.apisix.llm.script = (req: ChatRequest): ScriptedReply => {
			const last = req.messages.at(-1);
			return last?.role === 'tool'
				? { content: `Found: ${last.content ?? ''}` }
				: { toolCalls: call('search_notes', { q: 'plan' }), hold: statusShown(() => asked) };
		};
		const seen = r.questions().length;
		const before = feedback.shown().length;
		asked = await r.client.sendText(r.room, 'Find my plan in my notes');
		const question = await r.nextQuestion(seen);
		const status = await replySaying(asked, ASKING);
		expect(status?.original).toMatchObject({ body: WORKING });
		// The question follows, a message of its own, which my next message answers
		expect(shownSince(before).map((m) => m.eventId)).toEqual([status?.eventId, question]);
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'yes');
		expect(await r.nextSaying('Found:', found)).toBe('Found: {"status":200,"body":{"ok":true}}');
	});

	it('gives the status up when no answer comes in time, the answer then following', async () => {
		let asked = '';
		r.h.apisix.llm.script = () => ({
			content: 'A late answer',
			hold: eventually(() => replyTo(asked)?.body === LATE, STATUS_MAX_MS + 15_000)
		});
		const before = feedback.shown().length;
		asked = await r.client.sendText(r.room, 'Take all the time you need');
		const status = await replySaying(asked, LATE, STATUS_MAX_MS + 15_000);
		expect(status?.original).toMatchObject({ body: WORKING });
		expect(await shows('A late answer')).toBe(true);
		expect(shownSince(before).map((m) => m.body)).toEqual([LATE, 'A late answer']);
	});

	it('gives the status up when the matrix role stops, the answer following once it is back', async () => {
		let asked = '';
		let restarted = false;
		r.h.apisix.llm.script = () => ({
			content: 'An answer after the restart',
			hold: eventually(() => restarted, 60_000)
		});
		const before = feedback.shown().length;
		asked = await r.client.sendText(r.room, 'Work through the restart');
		expect(await eventually(() => replyTo(asked)?.body === WORKING, 20_000)).toBe(true);
		await r.h.restartRole();
		restarted = true;
		expect(await shows('An answer after the restart', 30_000)).toBe(true);
		expect(shownSince(before).map((m) => m.body)).toEqual([LATE, 'An answer after the restart']);
	});
});
