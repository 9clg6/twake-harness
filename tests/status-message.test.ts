import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
const ASKING = 'I need your answer to go on: see below.';
const LATE = 'This is taking longer than expected. If no answer follows, ask me again.';
const FAILED = 'Something went wrong on my side. Please try again in a moment.';

// The delay the deployment gives a turn before its status shows, the default
const STATUS_DELAY_MS = 3000;
// How long a status waits for its turn's answer before it gives up, short enough to be seen here,
// long enough for every other turn of the suite to answer before
const STATUS_MAX_MS = 15_000;

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

	// The id of the eyes the assistant put on an event, or an empty string when there are none
	function eyesOn(eventId: string): string {
		return feedback.reactionsOn(eventId).find((x) => x.key === '👀')?.eventId ?? '';
	}

	it('posts a status when my message takes a while, then turns it into the answer', async () => {
		let asked = '';
		const answer = 'Here is **the** answer';
		r.h.apisix.llm.script = () => ({ content: answer, hold: statusShown(() => asked) });
		const before = feedback.shown().length;
		asked = await r.client.sendText(r.room, 'Take your time');
		const shown = await replySaying(asked, answer);
		expect(shown?.original).toMatchObject({ msgtype: 'm.text', body: WORKING });
		// The answer as it would have gone out on its own, in the status's place
		expect(shown?.content).toEqual({
			msgtype: 'm.text',
			body: answer,
			format: 'org.matrix.custom.html',
			formatted_body: 'Here is <strong>the</strong> answer'
		});
		expect(shownSince(before)).toHaveLength(1);
		// The homeserver relates the edit to the status, as the relation travels in clear: a client
		// that loads the room later is told of it
		const edit = shown?.edits.at(-1);
		const status = await r.h.synapse.request(
			r.alice,
			'GET',
			`/_matrix/client/v3/rooms/${encodeURIComponent(r.room)}/event/${encodeURIComponent(shown?.eventId ?? '')}`
		);
		const relations = (status.body['unsigned'] as Record<string, unknown> | undefined)?.[
			'm.relations'
		] as Record<string, unknown> | undefined;
		expect(relations?.['m.replace']).toMatchObject({ event_id: edit?.eventId });
		// The eyes and the check mark stay on my message
		const check = await eventually(() => feedback.reactionsOn(asked).find((x) => x.key === '✅'));
		expect(check).toBeDefined();
		expect(feedback.reactionsOn(asked).some((x) => x.key === '👀')).toBe(true);
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

	it('turns the status into the failure notice when the turn fails', async () => {
		let asked = '';
		r.h.apisix.llm.script = () => ({ content: null, hold: statusShown(() => asked) });
		const before = feedback.shown().length;
		asked = await r.client.sendText(r.room, 'Break, slowly');
		const shown = await replySaying(asked, FAILED);
		expect(shown?.original).toMatchObject({ body: WORKING });
		expect(shownSince(before)).toHaveLength(1);
		// No check mark on a message that was not answered, as before
		expect(await eventually(() => feedback.isRedacted(eyesOn(asked)), 10_000)).toBe(true);
		expect(feedback.reactionsOn(asked).filter((x) => x.key === '✅')).toEqual([]);
	});

	it('posts a status on the turn my yes resumes, then turns it into its answer', async () => {
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
		const answer = 'Found: {"status":200,"body":{"ok":true}}';
		const shown = await replySaying(request, answer);
		expect(shown?.original).toMatchObject({ body: WORKING });
		expect(shown?.content).toMatchObject({ body: answer, format: 'org.matrix.custom.html' });
		expect(shownSince(before)).toHaveLength(1);
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
