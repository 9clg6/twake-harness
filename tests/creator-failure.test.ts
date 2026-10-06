import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withPrincipal } from '../src/db/client.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// On dev, an assistant row left by an earlier build held the Matrix account a new creation needed:
// the save failed, the failure ended the whole matrix role, and the owner was left with a room
// nobody answered and a creator still waiting for a name.
describe('an assistant creation that fails', () => {
	let h: MatrixTestHarness;
	let alice: MatrixUser;
	let aliceClient: E2eeClient;
	let creatorRoom: string;
	let replies = 0;
	const owner = 'alice@test.local';
	// The principal the builds before the email one gave the same person: their Matrix localpart
	const legacyOwner = 'alice';
	const assistantId = '@twake-space-assistant-alice:test.local';

	beforeAll(async () => {
		h = await startMatrixHarness();
		alice = await h.synapse.registerUser('alice');
		aliceClient = await startE2eeClient(h.synapse.url, alice);
		creatorRoom = await h.synapse.createDirectRoom(alice, h.role.creatorUserId);
		await h.synapse.waitForMessage(alice, creatorRoom, h.role.creatorUserId, (t) =>
			t.includes('/newbot')
		);
		replies = 1;
	}, 180_000);
	afterAll(async () => {
		if (aliceClient !== undefined) await aliceClient.stop();
		if (h !== undefined) await h.close();
	});

	// Sends a message to the creator and returns its next reply
	async function ask(text: string): Promise<string> {
		await h.synapse.sendText(alice, creatorRoom, text);
		for (let i = 0; i < 80; i += 1) {
			const all = await h.synapse.messagesFrom(alice, creatorRoom, h.role.creatorUserId);
			if (all.length > replies) {
				replies = all.length;
				return all[all.length - 1] ?? '';
			}
			await sleep(250);
		}
		throw new Error(`the creator did not answer « ${text} »`);
	}

	// The rooms the assistants opened, through the gateway. Polling the owner's invitations instead would
	// cache an empty /sync on Synapse, which would then hide the next test's invitation for minutes.
	function roomsCreated(): number {
		return h.apisix.matrixCalls.filter((call) => call.path.includes('/createRoom')).length;
	}

	async function invitesFromAssistant(): Promise<{ roomId: string; inviter: string }[]> {
		return (await h.synapse.pendingInvites(alice)).filter((inv) => inv.inviter === assistantId);
	}

	it('tells the owner, starts the dialog over, leaves no invitation behind, and keeps the role up', async () => {
		const roomsCreatedBefore = roomsCreated();
		// A live row of the old principal still holds the account: the save cannot succeed
		await withPrincipal(h.db, { id: legacyOwner }, async (tx) => {
			await tx.sql`insert into assistants (owner, user_id, name) values (${legacyOwner}, ${assistantId}, ${'Lucie'})`;
		});
		expect(await ask('/newbot')).toMatch(/name/i);
		expect(await ask('Jarvis')).toBe(
			'I could not create your assistant. Send /newbot to try again in a moment.'
		);

		const failures = h.logLines().filter((line) => line['msg'] === 'assistant creation failed');
		expect(failures).toHaveLength(1);
		expect(failures[0]?.['level']).toBe(50);
		expect(failures[0]?.['owner']).toBe(owner);
		// The name is the owner's own text, which an error log never carries
		expect(JSON.stringify(failures)).not.toContain('Jarvis');

		// The dialog started over: the same text is no longer taken for a name
		expect(await ask('Jarvis')).toContain('did not understand');
		// Nothing half-made: the save failed before any room was created, so no invitation reached
		// the owner, and no room is indexed
		expect(roomsCreated()).toBe(roomsCreatedBefore);
		const rooms = await h.db.sql`select room_id from assistant_rooms where owner = ${owner}`;
		expect(rooms).toHaveLength(0);
		// And the role is still up
		const health = await fetch(`http://127.0.0.1:${h.port}/health`);
		expect(health.status).toBe(200);
	}, 120_000);

	it('creates the assistant on the next /newbot once the account is free, and it answers', async () => {
		await withPrincipal(h.db, { id: legacyOwner }, async (tx) => {
			await tx.sql`delete from assistants where owner = ${legacyOwner}`;
		});
		expect(await ask('/newbot')).toMatch(/name/i);
		const done = await ask('Jarvis');
		expect(done).toContain(assistantId);
		let invites = await invitesFromAssistant();
		for (let i = 0; i < 40 && invites.length === 0; i += 1) {
			await sleep(250);
			invites = await invitesFromAssistant();
		}
		expect(invites).toHaveLength(1);
		const room = invites[0]?.roomId ?? '';
		await aliceClient.joinRoom(room);
		await aliceClient.waitForMessage(room, assistantId, (t) => t.includes('Jarvis'));
		await aliceClient.sendText(room, 'still there?');
		const answer = await aliceClient.waitForMessage(room, assistantId, (t) =>
			t.includes('still there?')
		);
		expect(answer).toContain('still there?');
	}, 180_000);
});
