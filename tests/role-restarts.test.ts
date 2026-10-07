import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import type { ChatRequest } from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import {
	PROVISIONER,
	provisionUntilReady,
	type ProvisionedAssistant
} from './helpers/provisioning.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Synapse pushes no to-device message while it holds the matrix role for down, as it does for a
// while once the role stopped: the key share of a message written meanwhile waits in the assistant
// device's inbox. The owner opens a room where every message has a room key of its own, so that
// every message needs its key share, as one does each time the owner's client starts a new room key.
describe('an assistant whose matrix role restarts', () => {
	let h: MatrixTestHarness;
	const clients: E2eeClient[] = [];

	// A new owner opens a room with their provisioned assistant and they exchange a first message
	async function meetProvisionedAssistant(
		localpart: string
	): Promise<{ client: E2eeClient; assistant: ProvisionedAssistant; room: string }> {
		const owner = await h.synapse.registerUser(localpart);
		const client = await startE2eeClient(h.synapse.url, owner);
		clients.push(client);
		const assistant = await provisionUntilReady(h.api, owner.userId);
		const room = await client.createDirectRoom(assistant.userId, { rotationPeriodMsgs: 1 });
		await h.synapse.waitForMember(owner, room, assistant.userId);
		await client.sendText(room, 'hello');
		await client.waitForMessage(room, assistant.userId, (t) => t === 'echo: hello');
		return { client, assistant, room };
	}

	// The owner writes while the role is down, then the role comes back
	async function writeWhileDown(
		client: E2eeClient,
		room: string,
		...texts: string[]
	): Promise<void> {
		await h.role.stop();
		for (const text of texts) await client.sendText(room, text);
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
		const { client, assistant, room } = await meetProvisionedAssistant('hal');

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

	it('answers every message its owner wrote while the role was down', async () => {
		const { client, assistant, room } = await meetProvisionedAssistant('kay');

		await writeWhileDown(client, room, 'first while down', 'second while down');
		for (const text of ['first while down', 'second while down']) {
			expect(
				await client.waitForMessage(room, assistant.userId, (t) => t === `echo: ${text}`, 60_000)
			).toBe(`echo: ${text}`);
		}
	});

	it('answers every message that failed to decrypt while its inbox was being read', async () => {
		const { client, assistant, room } = await meetProvisionedAssistant('max');
		// The first read of the assistant's inbox after the restart waits at the gateway, so that the
		// messages written while the role was down fail to decrypt meanwhile
		let release = (): void => undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let held = 0;
		h.apisix.matrixHold = (call) => {
			const target = new URL(call.path, 'http://synapse');
			if (
				held > 0 ||
				target.pathname !== '/_matrix/client/v3/sync' ||
				target.searchParams.get('user_id') !== assistant.userId
			) {
				return null;
			}
			held += 1;
			return released;
		};
		try {
			await h.role.stop();
			const first = await client.sendText(room, 'one while down');
			const second = await client.sendText(room, 'two while down');
			await sleep(1500);
			await h.restartRole();
			const failed = (): number =>
				h
					.logLines()
					.filter(
						(line) =>
							line['msg'] === 'decryption failed' &&
							(line['eventId'] === first || line['eventId'] === second)
					).length;
			for (let i = 0; i < 120 && failed() < 2; i += 1) await sleep(250);
			expect(failed()).toBe(2);
		} finally {
			h.apisix.matrixHold = null;
			release();
		}
		expect(held).toBe(1);
		for (const text of ['one while down', 'two while down']) {
			expect(
				await client.waitForMessage(room, assistant.userId, (t) => t === `echo: ${text}`, 60_000)
			).toBe(`echo: ${text}`);
		}
	});

	it('reads a key share behind more to-device messages than the homeserver hands at once', async () => {
		const { client, assistant, room } = await meetProvisionedAssistant('ivy');
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
});
