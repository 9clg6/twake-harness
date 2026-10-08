import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	activityEvent,
	lastUser,
	startActivityExchange,
	turnCalls,
	until,
	type ActivityExchange
} from './helpers/activity.js';
import { makeSettableClock } from './helpers/clock.js';
import { call, readCatalog, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import type { ChatRequest, ScriptedReply } from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';

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

	it('keeps my day spent for the assistant I create again', async () => {
		await r.client.sendText(r.room, 'Hello');
		await r.client.waitForMessage(r.room, r.assistantId, (t) => t === 'Heard: Hello');
		expect((await r.h.api.delete(ALICE, '/v1/assistants/me')).status).toBe(204);
		second = await newAssistant();
		await r.client.sendText(second, 'Hello again');
		await r.client.waitForMessage(second, r.assistantId, (t) => t.startsWith(DAY_SPENT));
	});
});
