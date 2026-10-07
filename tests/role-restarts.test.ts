import { CryptoClient } from 'matrix-bot-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import type { ChatRequest } from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import {
	PROVISIONER,
	provisionUntilReady,
	type ProvisionedAssistant
} from './helpers/provisioning.js';
import type { MatrixUser } from './helpers/synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The encryption machines this process opens, by user: the SDK opens one each time it prepares
// the encryption of a client, on the store of that client's user
const machinesOpened: string[] = [];
const sdkPrepare = CryptoClient.prototype.prepare;
CryptoClient.prototype.prepare = async function (this: CryptoClient, roomIds: string[]) {
	const opens = !this.isReady;
	await sdkPrepare.call(this, roomIds);
	if (opens) {
		const client = Reflect.get(this, 'client') as { getUserId(): Promise<string> };
		machinesOpened.push(await client.getUserId());
	}
};

function machinesOf(userId: string): number {
	return machinesOpened.filter((opened) => opened === userId).length;
}

// The owner opens a room where every message has a room key of its own, so that every message
// needs its key share, as one does each time the owner's client starts a new room key
describe('an assistant whose matrix role restarts', () => {
	let h: MatrixTestHarness;
	const clients: E2eeClient[] = [];

	async function waitForMember(viewer: MatrixUser, roomId: string, userId: string): Promise<void> {
		for (let i = 0; i < 80; i += 1) {
			if ((await h.synapse.joinedMembers(viewer, roomId)).includes(userId)) return;
			await sleep(250);
		}
		throw new Error(`${userId} never joined ${roomId}`);
	}

	// An owner, their assistant, and the room the owner opens with it, once they spoke there
	async function conversation(
		localpart: string
	): Promise<{ client: E2eeClient; assistant: ProvisionedAssistant; room: string }> {
		const owner = await h.synapse.registerUser(localpart);
		const client = await startE2eeClient(h.synapse.url, owner);
		clients.push(client);
		const assistant = await provisionUntilReady(h.api, owner.userId);
		const room = await client.client.createRoom({
			invite: [assistant.userId],
			is_direct: true,
			preset: 'trusted_private_chat',
			initial_state: [
				{
					type: 'm.room.encryption',
					state_key: '',
					content: { algorithm: 'm.megolm.v1.aes-sha2', rotation_period_msgs: 1 }
				}
			]
		});
		await waitForMember(owner, room, assistant.userId);
		await client.sendText(room, 'hello');
		await client.waitForMessage(room, assistant.userId, (t) => t === 'echo: hello');
		return { client, assistant, room };
	}

	// The owner writes while the role is down, then the role comes back. Synapse pushes no to-device
	// message while it holds the role for down, as it does for a while once the role stopped: the
	// key share of the message waits in the assistant device's inbox.
	async function writeWhileDown(client: E2eeClient, room: string, text: string): Promise<void> {
		await h.role.stop();
		await client.sendText(room, text);
		await sleep(1500);
		await h.restartRole();
	}

	beforeAll(async () => {
		h = await startMatrixHarness({ env: { PROVISIONER_CLIENT_IDS: PROVISIONER } });
		h.apisix.llm.script = (request: ChatRequest) => ({
			content: `echo: ${request.messages.at(-1)?.content ?? ''}`
		});
	}, 240_000);
	afterAll(async () => {
		for (const client of clients) await client.stop();
		if (h !== undefined) await h.close();
	});

	it('reads the key shares its owner sent while the role was down, however soon it went down again', async () => {
		const { client, assistant, room } = await conversation('hal');

		await writeWhileDown(client, room, 'are you there');
		expect(
			await client.waitForMessage(
				room,
				assistant.userId,
				(t) => t === 'echo: are you there',
				60_000
			)
		).toBe('echo: are you there');

		// Down again a moment later, as during a rollout that goes wrong
		await writeWhileDown(client, room, 'still there');
		expect(
			await client.waitForMessage(room, assistant.userId, (t) => t === 'echo: still there', 60_000)
		).toBe('echo: still there');
	});

	it('reads a key share behind more to-device messages than the homeserver hands at once', async () => {
		const { client, assistant, room } = await conversation('ivy');
		// Synapse keeps every to-device message of a device until the device syncs past it, those it
		// pushed included, and hands a hundred at most per sync, the oldest first
		for (let i = 0; i < 120; i += 1) {
			await client.client.sendToDevices('org.example.note', {
				[assistant.userId]: { [assistant.deviceId]: { n: i } }
			});
		}

		await writeWhileDown(client, room, 'behind the queue');
		expect(
			await client.waitForMessage(
				room,
				assistant.userId,
				(t) => t === 'echo: behind the queue',
				60_000
			)
		).toBe('echo: behind the queue');
	});

	it('opens one encryption machine per assistant at each start of the role', async () => {
		const { client, assistant, room } = await conversation('jo');
		// Two machines on one store would each keep its own sessions, and write over the other's
		expect(machinesOf(assistant.userId)).toBe(1);

		await h.restartRole();
		await client.sendText(room, 'and now');
		expect(await client.waitForMessage(room, assistant.userId, (t) => t === 'echo: and now')).toBe(
			'echo: and now'
		);
		await client.sendText(room, 'once more');
		expect(
			await client.waitForMessage(room, assistant.userId, (t) => t === 'echo: once more')
		).toBe('echo: once more');
		expect(machinesOf(assistant.userId)).toBe(2);
	});
});
