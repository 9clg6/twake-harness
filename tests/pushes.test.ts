import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import type { ChatRequest } from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Short, so that a push held up inside the SDK is given up within the test
const PUSH_DEADLINE_MS = 3000;

interface Conversation {
	readonly client: E2eeClient;
	readonly room: string;
	readonly assistantId: string;
}

// Synapse pushes the transactions of an application service one at a time, in order, and pushes a
// failed one again until it goes through: a push the role never answers holds up every later one,
// whichever assistant they are for.
describe('a push that fails on the encryption of an assistant', () => {
	let h: MatrixTestHarness;
	const clients: E2eeClient[] = [];

	// The owner creates an assistant, joins the room it opens, and is answered once
	async function meetAssistant(localpart: string, name: string): Promise<Conversation> {
		const owner = await h.synapse.registerUser(localpart);
		const client = await startE2eeClient(h.synapse.url, owner);
		clients.push(client);
		const created = await h.api.post<{ roomId: string }>(
			`${localpart}@test.local`,
			'/v1/assistants',
			{ name }
		);
		expect(created.status).toBe(201);
		const room = created.body.roomId;
		for (let i = 0; i < 40; i += 1) {
			const invites = await h.synapse.pendingInvites(owner);
			if (invites.some((inv) => inv.roomId === room)) break;
			await sleep(250);
		}
		await client.joinRoom(room);
		const assistantId = `@twake-space-assistant-${localpart}:test.local`;
		await client.waitForMessage(room, assistantId, (t) => t.includes(name));
		await client.sendText(room, 'hello');
		expect(await client.waitForMessage(room, assistantId, (t) => t === 'echo: hello')).toBe(
			'echo: hello'
		);
		return { client, room, assistantId };
	}

	// The check of the device an assistant speaks from, the step of its encryption setup that names its
	// device, fails at the homeserver until the role has left the assistant's key updates out of a push
	function failDeviceChecksUntilSetAside(userId: string): () => number {
		let failed = 0;
		h.apisix.matrixFault = (call) => {
			const target = new URL(call.path, 'http://synapse');
			if (
				target.pathname !== '/_matrix/client/v3/account/whoami' ||
				target.searchParams.get('user_id') !== userId ||
				setAsideFor(userId).length > 0
			) {
				return null;
			}
			failed += 1;
			return 500;
		};
		return () => failed;
	}

	function setAsideFor(userId: string): Record<string, unknown>[] {
		return linesOf('key updates left out of a push').filter(
			(l) => Array.isArray(l['userIds']) && l['userIds'].includes(userId)
		);
	}

	function linesOf(msg: string): Record<string, unknown>[] {
		return h.logLines().filter((l) => l['msg'] === msg);
	}

	beforeAll(async () => {
		h = await startMatrixHarness({ pushDeadlineMs: PUSH_DEADLINE_MS });
		h.apisix.llm.script = (request: ChatRequest) => ({
			content: `echo: ${request.messages.at(-1)?.content ?? ''}`
		});
	}, 240_000);
	afterAll(async () => {
		for (const client of clients) await client.stop();
		if (h !== undefined) await h.close();
	});

	it('does not hold up the pushes after one whose encryption setup fails, and reads it later', async () => {
		const nora = await meetAssistant('nora', 'Ida');
		const omar = await meetAssistant('omar', 'Kim');
		const failures = failDeviceChecksUntilSetAside(nora.assistantId);
		try {
			// The setup of nora's assistant fails as the role starts, then in the push of her next message
			await h.restartRole();
			expect(failures()).toBeGreaterThan(0);
			// Synapse delivers again once a push goes through
			await omar.client.sendText(omar.room, 'ping');
			expect(
				await omar.client.waitForMessage(omar.room, omar.assistantId, (t) => t === 'echo: ping')
			).toBe('echo: ping');
			const asked = await nora.client.sendText(nora.room, 'are you there?');
			await omar.client.sendText(omar.room, 'and you?');
			expect(
				await omar.client.waitForMessage(omar.room, omar.assistantId, (t) => t === 'echo: and you?')
			).toBe('echo: and you?');
			expect(setAsideFor(nora.assistantId)).not.toEqual([]);
			// Her message is read once the setup works, its key being in the store already
			expect(
				await nora.client.waitForMessage(
					nora.room,
					nora.assistantId,
					(t) => t === 'echo: are you there?'
				)
			).toBe('echo: are you there?');
			// Read late, it is a message like any other: its turn is queued under its own event, and
			// marked answered once the assistant answered it
			expect((await h.decisionOn(asked))?.['msg']).toBe('turn queued');
			expect(await nora.client.waitForReactions(nora.room, asked, nora.assistantId, 2)).toContain(
				'✅'
			);
			await nora.client.sendText(nora.room, 'still there?');
			expect(
				await nora.client.waitForMessage(
					nora.room,
					nora.assistantId,
					(t) => t === 'echo: still there?'
				)
			).toBe('echo: still there?');
		} finally {
			h.apisix.matrixFault = null;
		}
	});

	it('gives up a push held up inside the SDK past its deadline, and processes it again', async () => {
		const pia = await meetAssistant('pia', 'Lou');
		const ravi = await meetAssistant('ravi', 'Max');
		// The homeserver holds the first request the SDK makes as the creator, inside a push of pia's room:
		// the look-up of the room's members, to find who can decrypt an event
		let release: () => void = () => undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const membersOfRoom = `/_matrix/client/v3/rooms/${encodeURIComponent(pia.room)}/joined_members`;
		let held = 0;
		h.apisix.matrixHold = (call) => {
			const target = new URL(call.path, 'http://synapse');
			const asUser = target.searchParams.get('user_id') ?? h.role.creatorUserId;
			if (held > 0 || target.pathname !== membersOfRoom || asUser !== h.role.creatorUserId) {
				return null;
			}
			held += 1;
			return released;
		};
		// Each answer first shares a room key of its own: the waits leave a slow runner time for it
		try {
			await pia.client.sendText(pia.room, 'slow one');
			await ravi.client.sendText(ravi.room, 'meanwhile');
			expect(
				await ravi.client.waitForMessage(
					ravi.room,
					ravi.assistantId,
					(t) => t === 'echo: meanwhile',
					30_000
				)
			).toBe('echo: meanwhile');
			expect(
				await pia.client.waitForMessage(
					pia.room,
					pia.assistantId,
					(t) => t === 'echo: slow one',
					30_000
				)
			).toBe('echo: slow one');
		} finally {
			h.apisix.matrixHold = null;
			release();
		}
		expect(held).toBe(1);
		expect(linesOf('push given up')).not.toEqual([]);
	});
});
