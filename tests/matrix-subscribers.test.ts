import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withPrincipal } from '../src/db/client.js';
import type { ReadMessage } from '../src/matrix/messages.js';
import type { ReadReceipt } from '../src/matrix/receipts.js';
import type { ReadingAssistant, Subscriber } from '../src/matrix/subscribers.js';
import { until } from './helpers/activity.js';
import { startE2eeClient } from './helpers/e2ee-client.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import { startFakeSpace, type FakeSpace } from './helpers/space.js';
import type { MatrixUser } from './helpers/synapse.js';

const LISTENER = '@twake-assistant:test.local';

// What the matrix role handed a subscriber of a message, and for whom it read it
interface Handed {
	readonly message: ReadMessage;
	readonly assistant: ReadingAssistant | null;
}

describe('the matrix role reads each message once, and hands it to its subscribers', () => {
	let h: MatrixTestHarness;
	let space: FakeSpace;
	// The present the role reads, the real one until a test sets its own
	let moment: Date | null = null;
	const clock = { now: (): Date => moment ?? new Date() };
	let alice: MatrixUser;
	let bob: MatrixUser;
	let channel: string;
	const handed: Handed[] = [];
	const receipts: ReadReceipt[] = [];
	const recorder: Subscriber = {
		name: 'recorder',
		message: async (message, assistant) => {
			handed.push({ message, assistant });
		},
		receipt: async (receipt) => {
			receipts.push(receipt);
		}
	};
	// Fails on whatever it is handed while a test breaks it, ahead of the recorder
	let breaking = false;
	const broken: Subscriber = {
		name: 'broken',
		message: async () => {
			if (breaking) throw new Error('the subscriber is down');
		},
		receipt: async () => {
			if (breaking) throw new Error('the subscriber is down');
		}
	};
	const handedOf = (eventId: string): Handed[] =>
		handed.filter(({ message }) => message.eventId === eventId);
	const receiptsBy = (userId: string, eventId: string): ReadReceipt[] =>
		receipts.filter((receipt) => receipt.userId === userId && receipt.eventId === eventId);

	// A message as a client writes it, with whatever its content holds
	async function send(user: MatrixUser, room: string, content: Record<string, unknown>) {
		const txn = `${Date.now()}-${Math.random()}`;
		const sent = await h.synapse.request(
			user,
			'PUT',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${txn}`,
			content
		);
		expect(sent.status).toBe(200);
		return sent.body['event_id'] as string;
	}

	// A public read receipt on a message of a room, as a client sends it
	async function read(user: MatrixUser, room: string, eventId: string): Promise<void> {
		const path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/receipt/m.read/${encodeURIComponent(eventId)}`;
		const sent = await h.synapse.request(user, 'POST', path, {});
		expect(sent.status).toBe(200);
	}

	beforeAll(async () => {
		space = await startFakeSpace();
		h = await startMatrixHarness({
			clock,
			subscribers: [broken, recorder],
			env: {
				SUGGESTIONS_ENABLED: 'true',
				SPACE_API_URL: space.url,
				SPACE_API_TOKEN: 'tws_secret'
			}
		});
		alice = await h.synapse.registerUser('alice');
		bob = await h.synapse.registerUser('bob');
		// A clear channel of Bob's, which Alice joined and where the listener was invited
		const created = await h.synapse.request(bob, 'POST', '/_matrix/client/v3/createRoom', {
			preset: 'public_chat',
			name: 'general'
		});
		channel = created.body['room_id'] as string;
		await h.synapse.joinRoom(alice, channel);
		await h.synapse.request(
			bob,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(channel)}/invite`,
			{ user_id: LISTENER }
		);
		await until('the listener joined the channel', async () =>
			(await h.synapse.joinedMembers(bob, channel)).includes(LISTENER)
		);
	}, 300_000);
	afterAll(async () => {
		if (h !== undefined) await h.close();
		if (space !== undefined) await space.close();
	});

	it('hands on a message of a channel the listener is in with its text, mentions, thread, author and the time it received it', async () => {
		moment = new Date('2026-10-19T09:00:00Z');
		try {
			const root = await h.synapse.sendText(bob, channel, 'The figures are in');
			// Bob answers in the thread of his message, naming Alice by the pill of her name
			const reply = await send(bob, channel, {
				msgtype: 'm.text',
				body: 'Alice, can you check them?',
				'm.mentions': { user_ids: [alice.userId] },
				'm.relates_to': { rel_type: 'm.thread', event_id: root }
			});
			await until('the reply was handed on', () => handedOf(reply).length > 0);
			expect(handedOf(root)).toEqual([
				{
					message: {
						roomId: channel,
						eventId: root,
						sender: bob.userId,
						text: 'The figures are in',
						mentions: [],
						thread: 'main',
						receivedAt: new Date('2026-10-19T09:00:00Z')
					},
					assistant: null
				}
			]);
			expect(handedOf(reply)).toEqual([
				{
					message: {
						roomId: channel,
						eventId: reply,
						sender: bob.userId,
						text: 'Alice, can you check them?',
						mentions: [alice.userId],
						thread: root,
						receivedAt: new Date('2026-10-19T09:00:00Z')
					},
					assistant: null
				}
			]);
		} finally {
			moment = null;
		}
	});

	it('hands on a read receipt of a channel the listener is in with who read, the message they read, and when the role received it', async () => {
		moment = new Date('2026-10-19T09:30:00Z');
		try {
			const message = await h.synapse.sendText(bob, channel, 'The minutes are up');
			await read(alice, channel, message);
			await until('her receipt was handed on', () => receiptsBy(alice.userId, message).length > 0);
			expect(receiptsBy(alice.userId, message)).toEqual([
				{
					roomId: channel,
					userId: alice.userId,
					eventId: message,
					thread: null,
					receivedAt: new Date('2026-10-19T09:30:00Z')
				}
			]);
		} finally {
			moment = null;
		}
	});

	it('hands on the thread a read receipt names, with the time the role received it whatever time it carries, but never a private receipt', async () => {
		moment = new Date('2026-10-19T11:00:00Z');
		try {
			const root = await h.synapse.sendText(bob, channel, 'The agenda is out');
			const reply = await send(bob, channel, {
				msgtype: 'm.text',
				body: 'Budget first',
				'm.relates_to': { rel_type: 'm.thread', event_id: root }
			});
			// Receipts as a homeserver may push them, each with the time it took it: Alice read the
			// thread up to the reply, and read the root privately; Bob read the root
			const pushed = await fetch(
				`http://127.0.0.1:${h.port}/_matrix/app/v1/transactions/receipts-${Date.now()}`,
				{
					method: 'PUT',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${h.hsToken}` },
					body: JSON.stringify({
						events: [],
						'de.sorunome.msc2409.ephemeral': [
							{
								type: 'm.receipt',
								room_id: channel,
								content: {
									[reply]: {
										'm.read': {
											[alice.userId]: { ts: Date.parse('2026-10-19T10:59:00Z'), thread_id: root }
										}
									},
									[root]: {
										'm.read.private': {
											[alice.userId]: { ts: Date.parse('2026-10-19T10:58:00Z') }
										},
										'm.read': { [bob.userId]: { ts: Date.parse('2026-10-19T10:59:30Z') } }
									}
								}
							}
						]
					})
				}
			);
			expect(pushed.status).toBe(200);
			await until('the receipts were handed on', () => receiptsBy(bob.userId, root).length > 0);
			expect(receiptsBy(alice.userId, reply)).toEqual([
				{
					roomId: channel,
					userId: alice.userId,
					eventId: reply,
					thread: root,
					receivedAt: new Date('2026-10-19T11:00:00Z')
				}
			]);
			expect(receiptsBy(bob.userId, root)).toEqual([
				{
					roomId: channel,
					userId: bob.userId,
					eventId: root,
					thread: null,
					receivedAt: new Date('2026-10-19T11:00:00Z')
				}
			]);
			// Her private receipt is hers alone
			expect(receiptsBy(alice.userId, root)).toEqual([]);
		} finally {
			moment = null;
		}
	});

	it('hands a message and a read receipt on to its other subscribers when one fails, and logs the failure as its own, never what the message says', async () => {
		breaking = true;
		try {
			const message = await h.synapse.sendText(bob, channel, 'The room is booked');
			await until('the message was handed on', () => handedOf(message).length > 0);
			await read(alice, channel, message);
			await until('her receipt was handed on', () => receiptsBy(alice.userId, message).length > 0);
			const failures = h
				.logLines()
				.filter((line) => line['subscriber'] === 'broken' && line['eventId'] === message);
			expect(
				failures.map(({ level, msg, subscriber, roomId, eventId }) => ({
					level,
					msg,
					subscriber,
					roomId,
					eventId
				}))
			).toEqual([
				{
					level: 50,
					msg: 'room message failed',
					subscriber: 'broken',
					roomId: channel,
					eventId: message
				},
				{
					level: 50,
					msg: 'read receipt failed',
					subscriber: 'broken',
					roomId: channel,
					eventId: message
				}
			]);
			expect(JSON.stringify(failures)).not.toContain('The room is booked');
		} finally {
			breaking = false;
		}
	});

	it('hands on a message of a listened conversation once, for the owner of the assistant that read it, with the thread its clear part alone names', async () => {
		// Carol brought her assistant into her encrypted conversation with Dave, who said yes
		const carol = await h.synapse.registerUser('carol');
		const dave = await h.synapse.registerUser('dave');
		const CAROL = 'carol@test.local';
		expect((await h.api.post(CAROL, '/v1/assistants', { name: 'Assistant carol' })).status).toBe(
			201
		);
		const [row] = await withPrincipal(
			h.db,
			{ id: CAROL },
			(tx) => tx.sql<{ user_id: string }[]>`select user_id from assistants where owner = ${CAROL}`
		);
		const assistant = row?.user_id ?? '';
		const carolClient = await startE2eeClient(h.synapse.url, carol);
		const daveClient = await startE2eeClient(h.synapse.url, dave);
		try {
			const room = await carolClient.createDirectRoom(dave.userId);
			await daveClient.joinRoom(room);
			await carolClient.client.sendStateEvent(
				room,
				'app.twake.chat.assistant_request',
				carol.userId,
				{ assistant_id: assistant, requested: true, ts: Date.now() }
			);
			await daveClient.client.sendStateEvent(
				room,
				'app.twake.chat.assistant_consent',
				dave.userId,
				{ assistant_id: assistant, accepted: true, ts: Date.now() }
			);
			await carolClient.client.inviteUser(assistant, room);
			await until(
				'her assistant listens',
				async () =>
					(await h.db.sql`select 1 from assistant_listened_rooms where room_id = ${room}`)
						.length === 1
			);
			moment = new Date('2026-10-19T10:00:00Z');
			const root = await daveClient.sendText(room, 'The figures are in');
			// Dave answers in the thread of his message, naming Carol by the pill of her name, as a
			// client may encrypt it: the relation in the clear part of the event alone
			const sealed = await daveClient.client.crypto.encryptRoomEvent(room, 'm.room.message', {
				msgtype: 'm.text',
				body: 'Carol, are yours right?',
				'm.mentions': { user_ids: [carol.userId] }
			});
			const reply = await daveClient.client.sendRawEvent(room, 'm.room.encrypted', {
				...sealed,
				'm.relates_to': { rel_type: 'm.thread', event_id: root }
			});
			await until('the reply was handed on', () => handedOf(reply).length > 0);
			expect(handedOf(reply)).toEqual([
				{
					message: {
						roomId: room,
						eventId: reply,
						sender: dave.userId,
						text: 'Carol, are yours right?',
						mentions: [carol.userId],
						thread: root,
						receivedAt: new Date('2026-10-19T10:00:00Z')
					},
					assistant: { owner: CAROL, userId: assistant }
				}
			]);
		} finally {
			moment = null;
			await carolClient.stop();
			await daveClient.stop();
		}
	});
});
