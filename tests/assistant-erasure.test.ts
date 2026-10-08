import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	activityEvent,
	lastUser,
	startActivityExchange,
	turnCalls,
	until,
	type ActivityEvent,
	type ActivityExchange
} from './helpers/activity.js';
import { makeSettableClock } from './helpers/clock.js';
import { call, readCatalog, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import type { ChatRequest, ScriptedReply } from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
const CAROL = 'carol@test.local';
const CAROLS_ASSISTANT = '@twake-space-assistant-carol:test.local';

// What I tell my assistant and keep for it, which no assistant of mine finds once I deleted it
const WORDS = 'My cat is called Tigrou';
const NOTE = 'Alice drinks green tea';
const SKILL = {
	name: 'Quarterly digest',
	description: 'How Alice wants her quarterly digest',
	content: '# Quarterly digest\nThree bullet points.'
};
const PROPOSAL = {
	name: 'Monday plan',
	description: 'How Alice plans her Mondays',
	content: '# Monday plan\nTasks first.'
};

// What the harness asks me the first time my assistant needs to read an application
function firstRead(domain: string): string {
	return `This is the first time I need to read your data in ${domain}.`;
}

// What the assistant says when my day is spent
const DAY_SPENT = 'I have reached my limit for the day';

// A literal model: it tells of the event a turn names, says what it remembers of me, searches our
// past conversations or the application I name, tells what a search found, and repeats anything
// else it hears
function literal(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	if (last?.role === 'tool') return { content: `Found: ${last.content ?? ''}` };
	const told = lastUser(request);
	const event = /\(id ([^)]+)\)/.exec(told)?.[1];
	if (event !== undefined) return { content: `Told of ${event}` };
	if (told === 'What do you remember?') {
		const prompt = request.messages[0]?.content ?? '';
		const remembered = [NOTE, SKILL.description].filter((thing) => prompt.includes(thing));
		return { content: `I remember: ${remembered.join(' and ') || 'nothing'}` };
	}
	const query = /^Search our conversations for (.+)$/.exec(told)?.[1];
	if (query !== undefined) return { toolCalls: call('session_search', { query }) };
	const domain = /^Search my (\w+)$/.exec(told)?.[1];
	if (domain !== undefined) return { toolCalls: call(`search_${domain}`, { q: 'budget' }) };
	return { content: `Heard: ${told}` };
}

interface PendingCalls {
	readonly pending_calls: { readonly id: string; readonly domain: string }[];
}

interface CreatedAssistant {
	readonly userId: string;
	readonly roomId: string;
}

describe('deleting my assistant erases what the harness keeps of it', () => {
	let activity: ActivityExchange;
	let r: ConsentRoom;
	let creatorId: string;
	// My conversation with the creator
	let creatorRoom: string;
	// The room I opened with the assistant myself, besides the one it opened
	let secondRoom: string;
	// The room of the assistant I created after deleting Jarvis
	let irisRoom: string;
	// The request that waited for my answer when I deleted Jarvis
	let waiting: string;
	// What the harness held of my identity before I deleted Jarvis
	let pinned: unknown;
	const told = activityEvent({ id: 'erasure-told-before', recipient: ALICE });

	beforeAll(async () => {
		activity = await startActivityExchange();
		// My words come faster than an owner's rate allows by default
		r = await startConsentRoom({ ...activity.settings, ADMISSION_USER_PER_MINUTE: '120' });
		await activity.listen(r.h);
		r.h.apisix.llm.script = literal;
		r.h.apisix.contracts.spec = readCatalog(['mail', 'drive']);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(2);
		r.h.apisix.contracts.handler = () => ({ status: 200, body: { items: ['Budget 2027'] } });
		creatorId = r.h.role.creatorUserId;
		creatorRoom = await r.client.createDirectRoom(creatorId);
		await r.client.waitForMessage(creatorRoom, creatorId, (t) => t.includes('/newbot'));
	}, 240_000);
	afterAll(async () => {
		if (activity !== undefined) await activity.close();
		if (r !== undefined) await r.close();
	});

	function fromCreator(): DecryptedMessage[] {
		return r.client.messages.filter((m) => m.roomId === creatorRoom && m.sender === creatorId);
	}

	// What the creator answers me next, once I wrote it a message
	async function answerTo(text: string): Promise<string> {
		const seen = fromCreator().length;
		await r.client.sendText(creatorRoom, text);
		await until(`the creator answered « ${text} »`, () => fromCreator().length > seen);
		return fromCreator()[seen]?.body ?? '';
	}

	// What my assistant answers me in a room once I wrote it a message: the first of its messages
	// since then that looks like the answer
	async function ask(
		room: string,
		text: string,
		answer: (body: string) => boolean
	): Promise<string> {
		const said = (): DecryptedMessage[] =>
			r.client.messages.filter((m) => m.roomId === room && m.sender === r.assistantId);
		const seen = said().length;
		await r.client.sendText(room, text);
		let answered: string | undefined;
		await until(`my assistant answered « ${text} »`, () => {
			answered = said()
				.slice(seen)
				.find((m) => answer(m.body))?.body;
			return answered !== undefined;
		});
		return answered ?? '';
	}

	// Joins the room my new assistant invited me to, none of the rooms I knew, and waits for it to
	// greet me there
	async function meetNewAssistant(name: string, known: readonly string[]): Promise<string> {
		const mine = await r.h.api.get<CreatedAssistant>(ALICE, '/v1/assistants/me');
		const room = mine.body.roomId;
		expect(known).not.toContain(room);
		await r.client.joinRoom(room);
		await r.client.waitForMessage(room, r.assistantId, (t) => t.includes(name));
		return room;
	}

	// The accounts whose sends failed for good, as the queue keeps them, each payload the JSON text
	// of its fields: no route shows them, so this is the one place a test reads the database
	async function failedSends(): Promise<string[]> {
		const rows = await r.h.db.sql<{ as_user_id: string }[]>`
			select (payload #>> '{}')::jsonb ->> 'asUserId' as as_user_id from jobs
			where status = 'failed' and kind = 'send' order by id`;
		return rows.map((row) => row.as_user_id);
	}

	// Everything my owner routes show of what I told my assistant and kept for it
	async function myRoutes(): Promise<Record<string, unknown>> {
		const [sessions, memory, skills, proposals, consents, pending] = await Promise.all(
			[
				'/v1/sessions',
				'/v1/memory',
				'/v1/skills',
				'/v1/skills/proposals',
				'/v1/consents',
				'/v1/pending-calls'
			].map((path) => r.h.api.get(ALICE, path))
		);
		return {
			sessions: sessions?.body['sessions'],
			memory: memory?.body,
			skills: skills?.body['skills'],
			proposals: proposals?.body['proposals'],
			consents: consents?.body['consents'],
			pending: pending?.body['pending_calls']
		};
	}

	const NOTHING = {
		sessions: [],
		memory: { memory: [], user: [] },
		skills: [],
		proposals: [],
		consents: [],
		pending: []
	};

	// What I keep for my assistant besides our conversations: a note, a skill, a skill it
	// proposed, and my permission to read my drive
	async function keepForMyAssistant(): Promise<void> {
		const kept = await r.h.api.tool(ALICE, 'memory', {
			action: 'add',
			target: 'user',
			content: NOTE
		});
		expect(kept.body['success']).toBe(true);
		expect((await r.h.api.post(ALICE, '/v1/skills', SKILL)).status).toBe(201);
		expect((await r.h.api.tool(ALICE, 'skills_propose', PROPOSAL)).status).toBe(200);
		expect((await r.h.api.put(ALICE, '/v1/consents/drive/read', {})).status).toBe(201);
	}

	it('remembers our conversations, what I keep for it and what I allowed, while I have it', async () => {
		await keepForMyAssistant();
		await ask(r.room, WORDS, (t) => t === `Heard: ${WORDS}`);
		expect(await ask(r.room, 'What do you remember?', (t) => t.startsWith('I remember:'))).toBe(
			`I remember: ${NOTE} and ${SKILL.description}`
		);
		expect(
			await ask(r.room, 'Search our conversations for Tigrou', (t) => t.startsWith('Found:'))
		).toContain(WORDS);
		// Allowed through the API: it reads my drive without asking
		expect(await ask(r.room, 'Search my drive', (t) => t.startsWith('Found:'))).toContain(
			'Budget 2027'
		);
		await activity.publish(told);
		await r.client.waitForMessage(r.room, r.assistantId, (t) => t === `Told of ${told.id}`, 60_000);
		// A room I opened with it myself
		secondRoom = await r.client.createDirectRoom(r.assistantId);
		await r.h.synapse.waitForMember(r.alice, secondRoom, r.assistantId);
		await ask(secondRoom, 'Are you here too?', (t) => t === 'Heard: Are you here too?');
		// Last, since my next words would answer it: a request that waits for my answer
		await ask(r.room, 'Search my mail', (t) => t.startsWith(firstRead('mail')));
		const pending = await r.h.api.get<PendingCalls>(ALICE, '/v1/pending-calls');
		expect(pending.body.pending_calls.map((p) => p.domain)).toEqual(['mail']);
		waiting = pending.body.pending_calls[0]?.id ?? '';
		const routes = await myRoutes();
		expect(routes['sessions']).toHaveLength(2);
		expect(routes['memory']).toEqual({ memory: [], user: [NOTE] });
		expect(routes['skills']).toHaveLength(1);
		expect(routes['proposals']).toHaveLength(1);
		expect(routes['consents']).toHaveLength(1);
		pinned = (await r.h.api.get(ALICE, '/v1/assistants/me/owner-identity')).body['pinned'];
		expect(pinned).toMatchObject({ pinned_by: 'first_use' });
	});

	it('keeps the jobs that failed for good, mine and those of others, while I have it', async () => {
		const carol = await r.h.synapse.registerUser('carol');
		// The homeserver refuses what my assistant and Carol's send
		const failing = new Set([r.assistantId, CAROLS_ASSISTANT]);
		r.h.apisix.matrixFault = (c) =>
			c.method === 'PUT' &&
			/\/rooms\/[^/]+\/send\/m\.room\./.test(c.path) &&
			failing.has(new URL(c.path, 'http://synapse').searchParams.get('user_id') ?? '')
				? 500
				: null;
		try {
			await r.client.sendText(secondRoom, 'Can you hear me?');
			const carols = await r.h.api.post<CreatedAssistant>(CAROL, '/v1/assistants', {
				name: 'Friday'
			});
			expect(carols.status).toBe(201);
			await r.h.synapse.joinRoom(carol, carols.body.roomId);
			await until('both sends failed for good', async () => (await failedSends()).length === 2);
		} finally {
			r.h.apisix.matrixFault = null;
		}
		expect((await failedSends()).sort()).toEqual([CAROLS_ASSISTANT, r.assistantId].sort());
	});

	it('erases our conversations, what I kept for it, what I allowed and what waited for me, once I confirm /delete', async () => {
		expect(await answerTo('/delete')).toContain('Delete Jarvis?');
		expect(await answerTo('yes')).toBe(
			'Your assistant is deleted. Send /newbot when you want a new one.'
		);
		expect((await r.h.api.get(ALICE, '/v1/assistants/me')).status).toBe(404);
		expect(await myRoutes()).toEqual(NOTHING);
		// The request that waited for my answer can no longer be allowed
		expect((await r.h.api.post(ALICE, `/v1/pending-calls/${waiting}/approve`, {})).status).toBe(
			404
		);
	});

	it('leaves every room it answered me in', async () => {
		for (const room of [r.room, secondRoom]) {
			await until(
				`the assistant left ${room}`,
				async () => !(await r.h.synapse.joinedMembers(r.alice, room)).includes(r.assistantId)
			);
		}
	});

	it("erases my jobs that failed for good, and keeps Carol's", async () => {
		expect(await failedSends()).toEqual([CAROLS_ASSISTANT]);
	});

	it('gives me a new assistant under the same Matrix identifier, which greets me in a new room and remembers nothing', async () => {
		expect(await answerTo('/newbot')).toBe('Which name do you want for your assistant?');
		expect(await answerTo('Iris')).toContain(`Done. Your assistant Iris is ${r.assistantId}`);
		irisRoom = await meetNewAssistant('Iris', [r.room, secondRoom]);
		expect(await ask(irisRoom, 'What do you remember?', (t) => t.startsWith('I remember:'))).toBe(
			'I remember: nothing'
		);
		expect(
			await ask(irisRoom, 'Search our conversations for Tigrou', (t) => t.startsWith('Found:'))
		).toBe('Found: {"sessions":[]}');
		// It asks again before it reads my drive
		await ask(irisRoom, 'Search my drive', (t) => t.startsWith(firstRead('drive')));
	});

	it('keeps the identity it holds of me', async () => {
		expect((await r.h.api.get(ALICE, '/v1/assistants/me/owner-identity')).body['pinned']).toEqual(
			pinned
		);
	});

	it('wakes my new assistant for no event it already told me of, however often the event comes again', async () => {
		await activity.publish(told);
		// Published after it: once my assistant tells me of this one, the replay was read
		const next = activityEvent({ id: 'erasure-told-after', recipient: ALICE });
		await activity.publish(next);
		await r.client.waitForMessage(
			irisRoom,
			r.assistantId,
			(t) => t === `Told of ${next.id}`,
			60_000
		);
		expect(turnCalls(r.h.apisix.llm.calls, told.id)).toHaveLength(1);
	});

	it('erases the same through the API, with no question', async () => {
		// A conversation through the API, beside the room, and the request about my drive that
		// waits for my answer in the room of Iris
		const chat = await r.h.api.post(ALICE, '/v1/chat', { message: 'My dog is called Rex' });
		expect(chat.status).toBe(200);
		await keepForMyAssistant();
		const pending = await r.h.api.get<PendingCalls>(ALICE, '/v1/pending-calls');
		expect(pending.body.pending_calls.map((p) => p.domain)).toEqual(['drive']);
		expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
		expect(await myRoutes()).toEqual(NOTHING);
		const id = pending.body.pending_calls[0]?.id ?? '';
		expect((await r.h.api.post(ALICE, `/v1/pending-calls/${id}/approve`, {})).status).toBe(404);
		const again = await r.h.api.post<CreatedAssistant>(ALICE, '/v1/assistants', { name: 'Iris' });
		expect(again.status).toBe(201);
		expect(again.body.userId).toBe(r.assistantId);
		const room = await meetNewAssistant('Iris', [r.room, secondRoom, irisRoom]);
		expect(await ask(room, 'What do you remember?', (t) => t.startsWith('I remember:'))).toBe(
			'I remember: nothing'
		);
		expect(await ask(room, 'Search our conversations for Rex', (t) => t.startsWith('Found:'))).toBe(
			'Found: {"sessions":[]}'
		);
	});

	it('keeps nothing of a turn that ran while I deleted my assistant, and sends nothing as it', async () => {
		const room = (await r.h.api.get<CreatedAssistant>(ALICE, '/v1/assistants/me')).body.roomId;
		const words = 'Remember that I moved to Lyon';
		// What the harness logs from my words on
		const logged = r.h.logLines().length;
		const since = (): Record<string, unknown>[] => r.h.logLines().slice(logged);
		let reached = (): void => undefined;
		const asked = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let release = (): void => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// The model keeps the turn waiting before it asks to remember what I said, proposes a skill
		// and reads my mail, which I never allowed
		r.h.apisix.llm.script = (request) => {
			if (lastUser(request) !== words || request.messages.at(-1)?.role !== 'user') {
				return literal(request);
			}
			reached();
			return {
				toolCalls: [
					...call('memory', { action: 'add', target: 'user', content: 'Alice moved to Lyon' }),
					...call('skills_propose', PROPOSAL),
					...call('search_mail', { q: 'budget' })
				],
				hold: held
			};
		};
		try {
			await r.client.sendText(room, words);
			await asked;
			expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
		} finally {
			release();
		}
		await until('the turn ended', () =>
			since().some((line) => line['msg'] === 'turn did not succeed' && line['roomId'] === room)
		);
		expect(await myRoutes()).toEqual(NOTHING);
		// What it would have answered as the assistant I deleted goes nowhere
		await until('its answer was dropped', () =>
			since().some(
				(line) =>
					line['msg'] === 'send dropped: no assistant for this room' && line['roomId'] === room
			)
		);
		r.h.apisix.llm.script = literal;
	});
});

describe('deleting my assistant once my day is spent', () => {
	// The present as the harness reads it: the day stays the same until a test moves it
	const clock = makeSettableClock('2026-10-08T09:00:00Z');
	let activity: ActivityExchange;
	let r: ConsentRoom;
	// The room of the assistant I created after deleting Jarvis
	let second: string;

	beforeAll(async () => {
		activity = await startActivityExchange();
		// A day of one turn
		r = await startConsentRoom(
			{ ...activity.settings, ADMISSION_USER_DAILY_TOKENS: '1' },
			{ clock }
		);
		await activity.listen(r.h);
		r.h.apisix.llm.script = literal;
	}, 240_000);
	afterAll(async () => {
		if (activity !== undefined) await activity.close();
		if (r !== undefined) await r.close();
	});

	// Gives me a new assistant through the API, whose room I join
	async function newAssistant(): Promise<string> {
		const created = await r.h.api.post<CreatedAssistant>(ALICE, '/v1/assistants', {
			name: 'Iris'
		});
		expect(created.status).toBe(201);
		const room = created.body.roomId;
		await r.client.joinRoom(room);
		await r.client.waitForMessage(room, r.assistantId, (t) => t.includes('Iris'));
		return room;
	}

	// The lines by which the turn workers deferred the turn of an event, so far
	function deferrals(event: ActivityEvent): Record<string, unknown>[] {
		return r.h
			.logLines()
			.filter((line) => line['msg'] === 'event turn deferred' && line['reqId'] === event.id);
	}

	// What my assistant answers me next in a room, whatever it says
	async function answerIn(room: string, text: string): Promise<string> {
		const said = (): DecryptedMessage[] =>
			r.client.messages.filter((m) => m.roomId === room && m.sender === r.assistantId);
		const seen = said().length;
		await r.client.sendText(room, text);
		await until(`my assistant answered « ${text} »`, () => said().length > seen);
		return said()[seen]?.body ?? '';
	}

	it('keeps my day spent for the assistant I create again', async () => {
		await r.client.sendText(r.room, 'Hello');
		await r.client.waitForMessage(r.room, r.assistantId, (t) => t === 'Heard: Hello');
		expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
		second = await newAssistant();
		await r.client.sendText(second, 'Hello again');
		await r.client.waitForMessage(second, r.assistantId, (t) => t.startsWith(DAY_SPENT));
	});

	it('never runs the turn of an event deferred before I deleted my assistant, even once the next one is back in the room the event was for', async () => {
		// My day is spent: the turn of this assignment waits for the next one
		const deferred = activityEvent({ id: 'erasure-deferred', recipient: ALICE });
		await activity.publish(deferred);
		await until('the turn of the event was deferred', () => deferrals(deferred).length > 0);
		// The turn workers stop while I delete my assistant and bring the next one back into the room
		// the event was for, so that no retry of the turn finds it gone meanwhile
		await r.h.stopTurnWorkers();
		expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
		await newAssistant();
		const invited = await r.h.synapse.request(
			r.alice,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(second)}/invite`,
			{ user_id: r.assistantId }
		);
		expect(invited.status).toBe(200);
		await until('the assistant is back in the room', () =>
			r.h
				.logLines()
				.some(
					(line) =>
						line['msg'] === 'assistant room opened by its owner' && line['roomId'] === second
				)
		);
		// Due again once its last delay passed: the turn workers, back, would queue it ahead of my words
		const last = deferrals(deferred).at(-1);
		const due = Number(last?.['time']) + Number(last?.['retryInMs']) + 1000;
		await until('the turn of the event is due again', () => Date.now() > due);
		// The next day: the turn of the event would now be admitted, and spend the day before my words
		clock.set('2026-10-09T09:00:00Z');
		r.h.startTurnWorkers();
		expect(await answerIn(second, 'Still there?')).toBe('Heard: Still there?');
		expect(turnCalls(r.h.apisix.llm.calls, deferred.id)).toHaveLength(0);
		expect(r.client.messages.some((m) => m.body === `Told of ${deferred.id}`)).toBe(false);
	}, 180_000);
});
