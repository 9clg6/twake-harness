import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	MatrixClient,
	RustSdkCryptoStorageProvider,
	SimpleFsStorageProvider
} from 'matrix-bot-sdk';
import { StoreType } from '@matrix-org/matrix-sdk-crypto-nodejs';

import type { MatrixUser } from './synapse.js';

export interface DecryptedMessage {
	readonly roomId: string;
	readonly sender: string;
	readonly body: string;
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
	// What the client could not read, for diagnosis
	readonly failures: DecryptionFailure[];
	joinRoom(roomId: string): Promise<void>;
	// Opens an encrypted direct message with someone, as Twake Chat does
	createDirectRoom(userId: string): Promise<string>;
	sendText(roomId: string, text: string): Promise<void>;
	waitForMessage(
		roomId: string,
		sender: string,
		predicate: (text: string) => boolean,
		timeoutMs?: number
	): Promise<string>;
	stop(): Promise<void>;
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
	const failures: DecryptionFailure[] = [];
	// Every event the sync brings, encrypted or not, to tell a dropped event from one never delivered
	const seen: { roomId: string; type: string; sender: string; eventId: string }[] = [];
	client.on(
		'room.event',
		(roomId: string, event: { type?: string; sender?: string; event_id?: string }) => {
			seen.push({
				roomId,
				type: event.type ?? '',
				sender: event.sender ?? '',
				eventId: event.event_id ?? ''
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
		(roomId: string, event: { sender: string; content: { body?: string } }) => {
			if (typeof event.content.body === 'string') {
				messages.push({ roomId, sender: event.sender, body: event.content.body });
			}
		}
	);
	await client.start();
	return {
		userId: user.userId,
		client,
		messages,
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
		sendText: async (roomId, text) => {
			await client.sendText(roomId, text);
		},
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
		stop: async () => {
			client.stop();
		}
	};
}
