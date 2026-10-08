import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import type { ChatRequest, MatrixCall } from './helpers/fake-apisix.js';
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

	// The to-device messages the homeserver keeps for a device, read as a first sync would, which
	// makes it drop none. Each read asks with a filter of its own: the homeserver answers a sync it
	// was just asked from its cache.
	let inboxReads = 0;
	async function inboxOf(userId: string, deviceId: string): Promise<number> {
		inboxReads += 1;
		// The device named by the stable parameter of MSC3202, the one every Synapse reads: from 1.162
		// on, the unstable one is ignored and the sync reads no device's inbox
		const query = new URLSearchParams({
			user_id: userId,
			device_id: deviceId,
			timeout: '0',
			filter: JSON.stringify({ room: { rooms: [] }, account_data: { limit: inboxReads } })
		});
		const res = await fetch(`${h.synapse.url}/_matrix/client/v3/sync?${query.toString()}`, {
			headers: { authorization: `Bearer ${h.config.matrix.asToken}` }
		});
		const body = (await res.json()) as { to_device?: { events?: unknown[] } };
		return body.to_device?.events?.length ?? 0;
	}

	// A read of the assistant's inbox, as it goes through the gateway
	function isInboxReadOf(userId: string, call: MatrixCall): boolean {
		const target = new URL(call.path, 'http://synapse');
		return (
			target.pathname === '/_matrix/client/v3/sync' && target.searchParams.get('user_id') === userId
		);
	}

	// Resolves once the matrix role logged that the message failed to decrypt
	async function failedToDecrypt(eventId: string): Promise<boolean> {
		for (let i = 0; i < 160; i += 1) {
			if (
				h
					.logLines()
					.some((line) => line['msg'] === 'decryption failed' && line['eventId'] === eventId)
			) {
				return true;
			}
			await sleep(250);
		}
		return false;
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

	it('answers a message whose key share a read took before a later page of it failed', async () => {
		const { client, assistant, room } = await meetProvisionedAssistant('ned');
		// The first page of the read at start waits until the message failed to decrypt and joined
		// the read, then the next page fails at the gateway
		let release = (): void => undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reads = 0;
		h.apisix.matrixFault = (call) => {
			if (!isInboxReadOf(assistant.userId, call)) return null;
			reads += 1;
			return reads === 2 ? 502 : null;
		};
		h.apisix.matrixHold = (call) =>
			isInboxReadOf(assistant.userId, call) && reads === 1 ? released : null;
		try {
			await h.role.stop();
			const sent = await client.sendText(room, 'one key, one failed page');
			await sleep(1500);
			await h.restartRole();
			expect(await failedToDecrypt(sent)).toBe(true);
			release();
			for (let i = 0; i < 40 && reads < 2; i += 1) await sleep(250);
		} finally {
			release();
			h.apisix.matrixHold = null;
			h.apisix.matrixFault = null;
		}
		expect(reads).toBeGreaterThanOrEqual(2);
		expect(
			await client.waitForMessage(
				room,
				assistant.userId,
				(t) => t === 'echo: one key, one failed page',
				60_000
			)
		).toBe('echo: one key, one failed page');
	});

	it('answers a message that failed to decrypt as a read of its inbox was ending', async () => {
		const { client, assistant, room } = await meetProvisionedAssistant('oli');
		// Synapse holds the role for down a while longer once it stayed down for several seconds, so
		// that the key share of a message written just after the restart waits in the inbox too
		await h.role.stop();
		await client.sendText(room, 'before the restart');
		await sleep(7000);
		// The read at start takes the key share above on its first page; its second page, empty, is
		// answered at once but comes back only once the next message failed to decrypt
		let release = (): void => undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reads = 0;
		let lastPageHeld = false;
		h.apisix.matrixHoldReply = (call) => {
			if (!isInboxReadOf(assistant.userId, call)) return null;
			reads += 1;
			if (reads !== 2) return null;
			lastPageHeld = true;
			return released;
		};
		try {
			await h.restartRole();
			for (let i = 0; i < 80 && !lastPageHeld; i += 1) await sleep(250);
			expect(lastPageHeld).toBe(true);
			const late = await client.sendText(room, 'right after the restart');
			expect(await failedToDecrypt(late)).toBe(true);
		} finally {
			release();
			h.apisix.matrixHoldReply = null;
		}
		for (const text of ['before the restart', 'right after the restart']) {
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

	it('empties its device inbox at each start of the role', async () => {
		const { client, assistant } = await meetProvisionedAssistant('lea');
		for (let i = 0; i < 120; i += 1) {
			await client.client.sendToDevices('org.example.note', {
				[assistant.userId]: { [assistant.deviceId]: { n: i } }
			});
		}
		// A full page, more waiting behind it
		expect(await inboxOf(assistant.userId, assistant.deviceId)).toBe(100);

		// Nothing fails to decrypt meanwhile: the role reads the inbox at its start all the same
		await h.restartRole();
		let left = await inboxOf(assistant.userId, assistant.deviceId);
		for (let i = 0; i < 60 && left > 0; i += 1) {
			await sleep(500);
			left = await inboxOf(assistant.userId, assistant.deviceId);
		}
		expect(left).toBe(0);
	});
});
