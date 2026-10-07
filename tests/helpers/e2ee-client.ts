import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	MatrixClient,
	RustSdkCryptoStorageProvider,
	SimpleFsStorageProvider
} from 'matrix-bot-sdk';
import {
	RequestType,
	StoreType,
	UserId,
	type OlmMachine
} from '@matrix-org/matrix-sdk-crypto-nodejs';

import type { MatrixUser } from './synapse.js';

export interface DecryptedMessage {
	readonly roomId: string;
	readonly eventId: string;
	readonly sender: string;
	readonly body: string;
	readonly content: Record<string, unknown>;
}

// Any event of a joined room as the client reads it, decrypted when it could be
export interface ReadEvent {
	readonly roomId: string;
	readonly type: string;
	readonly sender: string;
	readonly eventId: string;
	readonly content: Record<string, unknown>;
	readonly redacts: string | null;
}

export interface DecryptionFailure {
	readonly roomId: string;
	readonly eventId: string;
	readonly sender: string;
	readonly error: string;
}

export interface E2eeClient {
	readonly userId: string;
	readonly client: MatrixClient;
	readonly messages: DecryptedMessage[];
	readonly events: ReadEvent[];
	// What the client could not read, for diagnosis
	readonly failures: DecryptionFailure[];
	joinRoom(roomId: string): Promise<void>;
	// Opens an encrypted direct message with someone, as Twake Chat does
	createDirectRoom(userId: string): Promise<string>;
	// Resolves to the event id of the message sent
	sendText(roomId: string, text: string): Promise<string>;
	// Reacts to an event with a key such as ✅, encrypted like any event of an encrypted room;
	// resolves to the event id of the reaction
	react(roomId: string, eventId: string, key: string): Promise<string>;
	waitForMessage(
		roomId: string,
		sender: string,
		predicate: (text: string) => boolean,
		timeoutMs?: number
	): Promise<string>;
	// Resolves to the keys of a sender's reactions to an event, the labels Twake Chat shows under
	// it, once there are `count` of them or the time is up
	waitForReactions(
		roomId: string,
		eventId: string,
		sender: string,
		count: number,
		timeoutMs?: number
	): Promise<string[]>;
	stop(): Promise<void>;
}

// The event a reaction annotates, and its key
function annotationOf(
	content: Record<string, unknown>
): { readonly eventId: string; readonly key: string } | null {
	const relation: unknown = content['m.relates_to'];
	if (typeof relation !== 'object' || relation === null) return null;
	const eventId: unknown = Reflect.get(relation, 'event_id');
	const key: unknown = Reflect.get(relation, 'key');
	return typeof eventId === 'string' && typeof key === 'string' ? { eventId, key } : null;
}

// What matrix-bot-sdk keeps of its crypto engine to itself
interface CryptoEngine {
	readonly machine: OlmMachine;
	// Held by the client's sync while it hands what it received to the crypto machine
	readonly lock: { acquire(key: 'sync', run: () => Promise<void>): Promise<void> };
	addTrackedUsers(userIds: string[]): Promise<void>;
	runOnly(...types: RequestType[]): Promise<void>;
}

// matrix-bot-sdk starts tracking the members of a room as the client joins it or reads a membership:
// holding the lock of its sync, it asks the crypto machine which of their devices it lacks a session
// with, before their device lists were queried. The machine waits up to 5 s for each such query,
// which only the sync, blocked on that lock, would send: after a join, the client read nothing for
// 15 s. The SDK queries the device lists first when it encrypts; this client does so when it starts
// tracking members too.
function queryKeysBeforeTracking(client: MatrixClient): void {
	const crypto = client.crypto;
	const prepare = crypto.prepare.bind(crypto);
	crypto.prepare = async (roomIds) => {
		await prepare(roomIds);
		const engine = Reflect.get(crypto, 'engine') as CryptoEngine;
		const track = engine.addTrackedUsers.bind(engine);
		engine.addTrackedUsers = async (userIds) => {
			await engine.lock.acquire('sync', async () => {
				await engine.machine.updateTrackedUsers(userIds.map((userId) => new UserId(userId)));
				await engine.runOnly(RequestType.KeysQuery);
			});
			await track(userIds);
		};
	};
}

// A user's own Matrix client with end-to-end encryption, as Twake Chat would be, talking to
// Synapse directly.
export async function startE2eeClient(
	homeserverUrl: string,
	user: MatrixUser
): Promise<E2eeClient> {
	const dir = await mkdtemp(join(tmpdir(), 'e2ee-'));
	const client = new MatrixClient(
		homeserverUrl,
		user.accessToken,
		new SimpleFsStorageProvider(join(dir, 'bot.json')),
		new RustSdkCryptoStorageProvider(join(dir, 'crypto'), StoreType.Sqlite)
	);
	const messages: DecryptedMessage[] = [];
	const events: ReadEvent[] = [];
	const failures: DecryptionFailure[] = [];
	// Every event the sync brings, encrypted or not, to tell a dropped event from one never delivered
	const seen: { roomId: string; type: string; sender: string; eventId: string }[] = [];
	client.on(
		'room.event',
		(
			roomId: string,
			event: {
				type?: string;
				sender?: string;
				event_id?: string;
				content?: Record<string, unknown>;
				redacts?: string;
			}
		) => {
			seen.push({
				roomId,
				type: event.type ?? '',
				sender: event.sender ?? '',
				eventId: event.event_id ?? ''
			});
			const content = event.content ?? {};
			// Room versions up to 10 put the redacted event at the top, version 11 in the content
			const redacts =
				event.redacts ?? (typeof content['redacts'] === 'string' ? content['redacts'] : null);
			events.push({
				roomId,
				type: event.type ?? '',
				sender: event.sender ?? '',
				eventId: event.event_id ?? '',
				content,
				redacts
			});
		}
	);
	client.on(
		'room.failed_decryption',
		(roomId: string, event: { event_id?: string; sender?: string }, err: unknown) => {
			failures.push({
				roomId,
				eventId: event.event_id ?? '',
				sender: event.sender ?? '',
				error: err instanceof Error ? err.message : String(err)
			});
		}
	);
	client.on(
		'room.message',
		(
			roomId: string,
			event: { sender: string; event_id?: string; content: Record<string, unknown> }
		) => {
			const body = event.content['body'];
			if (typeof body === 'string') {
				messages.push({
					roomId,
					eventId: event.event_id ?? '',
					sender: event.sender,
					body,
					content: event.content
				});
			}
		}
	);
	queryKeysBeforeTracking(client);
	await client.start();
	return {
		userId: user.userId,
		client,
		messages,
		events,
		failures,
		joinRoom: async (roomId) => {
			await client.joinRoom(roomId);
		},
		createDirectRoom: (userId) =>
			client.createRoom({
				invite: [userId],
				is_direct: true,
				preset: 'trusted_private_chat',
				initial_state: [
					{
						type: 'm.room.encryption',
						state_key: '',
						content: { algorithm: 'm.megolm.v1.aes-sha2' }
					}
				]
			}),
		sendText: (roomId, text) => client.sendText(roomId, text),
		react: (roomId, eventId, key) =>
			client.sendEvent(roomId, 'm.reaction', {
				'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key }
			}),
		waitForMessage: async (roomId, sender, predicate, timeoutMs = 30_000) => {
			for (let i = 0; i < timeoutMs / 250; i += 1) {
				const found = messages.find(
					(m) => m.roomId === roomId && m.sender === sender && predicate(m.body)
				);
				if (found !== undefined) return found.body;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			const undecryptable = failures
				.filter((f) => f.roomId === roomId)
				.map((f) => `${f.sender} ${f.eventId}: ${f.error}`)
				.join('; ');
			const delivered = seen
				.filter((e) => e.roomId === roomId && e.sender === sender)
				.map((e) => `${e.type} ${e.eventId}`)
				.join(', ');
			const read = messages
				.filter((m) => m.roomId === roomId && m.sender === sender)
				.map((m) => JSON.stringify(m.body.slice(0, 60)))
				.join(', ');
			throw new Error(
				`no decrypted message from ${sender} in ${roomId} within ${timeoutMs} ms (read: ${read || 'nothing'})` +
					` (delivered from them: ${delivered || 'nothing'})` +
					(undecryptable.length > 0 ? ` (undecryptable: ${undecryptable})` : '')
			);
		},
		waitForReactions: async (roomId, eventId, sender, count, timeoutMs = 30_000) => {
			const keys = (): string[] =>
				events
					.filter((e) => e.roomId === roomId && e.type === 'm.reaction' && e.sender === sender)
					.map((e) => annotationOf(e.content))
					.filter((annotation) => annotation?.eventId === eventId)
					.map((annotation) => annotation?.key ?? '');
			for (let i = 0; i < timeoutMs / 250 && keys().length < count; i += 1) {
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			return keys();
		},
		stop: async () => {
			client.stop();
		}
	};
}
