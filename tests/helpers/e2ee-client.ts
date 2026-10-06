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

export interface E2eeClient {
	readonly userId: string;
	readonly client: MatrixClient;
	readonly messages: DecryptedMessage[];
	joinRoom(roomId: string): Promise<void>;
	sendText(roomId: string, text: string): Promise<void>;
	waitForMessage(
		roomId: string,
		sender: string,
		predicate: (text: string) => boolean
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
		joinRoom: async (roomId) => {
			await client.joinRoom(roomId);
		},
		sendText: async (roomId, text) => {
			await client.sendText(roomId, text);
		},
		waitForMessage: async (roomId, sender, predicate) => {
			for (let i = 0; i < 120; i += 1) {
				const found = messages.find(
					(m) => m.roomId === roomId && m.sender === sender && predicate(m.body)
				);
				if (found !== undefined) return found.body;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			throw new Error(`no decrypted message from ${sender} in ${roomId} within 30 s`);
		},
		stop: async () => {
			client.stop();
		}
	};
}
