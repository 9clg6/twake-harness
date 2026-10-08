import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeSettableClock } from './helpers/clock.js';
import { QUESTION_CONTENT_KEY } from './helpers/consent-room.js';
import { startE2eeClient, type DecryptedMessage, type E2eeClient } from './helpers/e2ee-client.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

const OWNER = 'alice@test.local';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The id of the question a message asks, as my client reads it from the message's content
function questionId(message: DecryptedMessage): unknown {
	const marker = message.content[QUESTION_CONTENT_KEY];
	return typeof marker === 'object' && marker !== null ? Reflect.get(marker, 'id') : null;
}

describe('the creator asks me to confirm before it deletes my assistant', () => {
	// The present as the harness reads it, which each test sets
	const clock = makeSettableClock('2026-10-08T09:00:00Z');
	let h: MatrixTestHarness;
	let alice: MatrixUser;
	let client: E2eeClient;
	// My conversation with the creator, encrypted as Twake Chat and the Chat front open it
	let room: string;
	let creatorId: string;
	beforeAll(async () => {
		h = await startMatrixHarness({ clock });
		alice = await h.synapse.registerUser('alice');
		client = await startE2eeClient(h.synapse.url, alice);
		creatorId = h.role.creatorUserId;
		room = await client.createDirectRoom(creatorId);
		await client.waitForMessage(room, creatorId, (t) => t.includes('/newbot'));
	}, 240_000);
	afterAll(async () => {
		if (client !== undefined) await client.stop();
		if (h !== undefined) await h.close();
	});

	// What the creator wrote me in our conversation, as my session read it
	function fromCreator(): DecryptedMessage[] {
		return client.messages.filter((m) => m.roomId === room && m.sender === creatorId);
	}

	// What the creator answers me next, once I wrote it a message
	async function answerTo(text: string): Promise<DecryptedMessage> {
		const seen = fromCreator().length;
		await client.sendText(room, text);
		for (let i = 0; i < 120; i += 1) {
			const next = fromCreator().at(seen);
			if (next !== undefined) return next;
			await sleep(250);
		}
		throw new Error(`the creator did not answer « ${text} »`);
	}

	async function myAssistant(): Promise<number> {
		return (await h.api.get(OWNER, '/v1/assistants/me')).status;
	}

	// Gives me a new assistant by that name through the API, deleting the one I had, if any
	async function newAssistant(name: string): Promise<void> {
		await h.api.delete(OWNER, '/v1/assistants/me');
		expect((await h.api.post(OWNER, '/v1/assistants', { name })).status).toBe(201);
	}

	it('answers /delete as before while I have no assistant, and asks me nothing', async () => {
		const answer = await answerTo('/delete');
		expect(answer.body).toBe('You have no assistant to delete.');
		expect(answer.content).not.toHaveProperty([QUESTION_CONTENT_KEY]);
		expect((await answerTo('yes')).body).toBe(
			'I did not understand « yes ». Send /help for the commands.'
		);
	});

	it('asks me, in a question my client can answer until ten minutes later, and deletes nothing yet', async () => {
		expect((await h.api.post(OWNER, '/v1/assistants', { name: 'Jarvis' })).status).toBe(201);
		clock.set('2026-10-08T09:00:00Z');
		const question = await answerTo('/delete');
		expect(question.body).toBe('Delete Jarvis? Answer yes to confirm.');
		expect(question.content[QUESTION_CONTENT_KEY]).toEqual({
			id: expect.stringMatching(UUID),
			expires_ts: Date.parse('2026-10-08T09:10:00Z')
		});
		// The question went through the homeserver encrypted, what tells it included
		const stored = await h.synapse.request(
			alice,
			'GET',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/event/${encodeURIComponent(question.eventId)}`
		);
		expect(stored.body['type']).toBe('m.room.encrypted');
		expect(stored.body['content']).not.toHaveProperty([QUESTION_CONTENT_KEY]);
		expect(await myAssistant()).toBe(200);
	});

	it('deletes my assistant when I answer yes within the ten minutes, in either language', async () => {
		// The question above, a second before it expires
		clock.set('2026-10-08T09:09:59Z');
		expect((await answerTo('yes')).body).toBe(
			'Your assistant is deleted. Send /newbot when you want a new one.'
		);
		expect(await myAssistant()).toBe(404);
		expect((await h.api.post(OWNER, '/v1/assistants', { name: 'Iris' })).status).toBe(201);
		clock.set('2026-10-08T10:00:00Z');
		expect((await answerTo('/delete')).body).toContain('Delete Iris?');
		clock.set('2026-10-08T10:05:00Z');
		expect((await answerTo('oui')).body).toBe(
			'Your assistant is deleted. Send /newbot when you want a new one.'
		);
		expect(await myAssistant()).toBe(404);
	});

	it('keeps my assistant, and tells me so, when I answer anything but yes', async () => {
		expect((await h.api.post(OWNER, '/v1/assistants', { name: 'Jarvis' })).status).toBe(201);
		clock.set('2026-10-08T11:00:00Z');
		const first = await answerTo('/delete');
		const cancelled = await answerTo('no');
		expect(cancelled.body).toBe('Deletion cancelled: your assistant stays.');
		expect(cancelled.content).not.toHaveProperty([QUESTION_CONTENT_KEY]);
		expect(await myAssistant()).toBe(200);
		// Anything else cancels too, a command included, and each /delete asks a question of its own
		const second = await answerTo('/delete');
		expect(questionId(second)).toMatch(UUID);
		expect(questionId(second)).not.toBe(questionId(first));
		expect((await answerTo('/mybot')).body).toBe('Deletion cancelled: your assistant stays.');
		// No question waits any more: a yes now answers nothing
		expect((await answerTo('yes')).body).toBe(
			'I did not understand « yes ». Send /help for the commands.'
		);
		expect(await myAssistant()).toBe(200);
	});

	it('deletes nothing when my yes comes once the ten minutes are over, and tells me so', async () => {
		clock.set('2026-10-08T12:00:00Z');
		expect((await answerTo('/delete')).body).toContain('Delete Jarvis?');
		clock.set('2026-10-08T12:10:00Z');
		expect((await answerTo('yes')).body).toBe(
			'This deletion request has expired, so I deleted nothing. Send /delete again if you still want to.'
		);
		expect(await myAssistant()).toBe(200);
		// A request that lapsed takes a command as any other
		clock.set('2026-10-08T13:00:00Z');
		expect((await answerTo('/delete')).body).toContain('Delete Jarvis?');
		clock.set('2026-10-08T13:15:00Z');
		expect((await answerTo('/mybot')).body).toContain('Your assistant Jarvis is');
		expect(await myAssistant()).toBe(200);
	});

	it('reads my messages as if nothing were asked once the assistant the question named is gone', async () => {
		await newAssistant('Jarvis');
		clock.set('2026-10-08T14:00:00Z');
		expect((await answerTo('/delete')).body).toContain('Delete Jarvis?');
		// Deleted from another client, through the API, while the question waits
		expect((await h.api.delete(OWNER, '/v1/assistants/me')).status).toBe(204);
		clock.set('2026-10-08T14:01:00Z');
		expect((await answerTo('/newbot')).body).toBe('Which name do you want for your assistant?');
		expect((await answerTo('Jarvis')).body).toContain('Done. Your assistant Jarvis is');
		expect(await myAssistant()).toBe(200);
	});

	it('deletes nothing when I answer yes about an assistant I deleted and created again since', async () => {
		await newAssistant('Jarvis');
		clock.set('2026-10-08T15:00:00Z');
		expect((await answerTo('/delete')).body).toContain('Delete Jarvis?');
		// Deleted and created again through the API while the question waits: the account is the same
		await newAssistant('Iris');
		clock.set('2026-10-08T15:01:00Z');
		expect((await answerTo('yes')).body).toBe(
			'This deletion request has expired, so I deleted nothing. Send /delete again if you still want to.'
		);
		expect(await myAssistant()).toBe(200);
	});
});
