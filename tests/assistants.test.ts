import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { activityEvent, startActivityExchange, type ActivityExchange } from './helpers/activity.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AssistantView {
	userId: string;
	name: string;
	roomId: string | null;
	link: string;
}

describe('creating an assistant, like a Telegram bot', () => {
	let activity: ActivityExchange;
	let h: MatrixTestHarness;
	let alice: MatrixUser;
	let aliceClient: E2eeClient;
	let creatorRoom: string;
	let room = '';
	let replies = 0;
	beforeAll(async () => {
		activity = await startActivityExchange();
		h = await startMatrixHarness({ env: activity.settings });
		await activity.listen(h);
		alice = await h.synapse.registerUser('alice');
		aliceClient = await startE2eeClient(h.synapse.url, alice);
		creatorRoom = await h.synapse.createDirectRoom(alice, h.role.creatorUserId);
		await h.synapse.waitForMessage(alice, creatorRoom, h.role.creatorUserId, (t) =>
			t.includes('/newbot')
		);
		replies = 1;
	}, 180_000);
	afterAll(async () => {
		if (activity !== undefined) await activity.close();
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

	const assistantId = '@twake-space-assistant-alice:test.local';

	it('asks for a name, creates the assistant, and the assistant opens a private room', async () => {
		expect(await ask('/newbot')).toMatch(/name/i);
		const done = await ask('Jarvis');
		expect(done).toContain(assistantId);
		expect(done).toContain('matrix.to');
		let invites: { roomId: string; inviter: string }[] = [];
		for (let i = 0; i < 40 && invites.length === 0; i += 1) {
			await sleep(250);
			invites = (await h.synapse.pendingInvites(alice)).filter(
				(inv) => inv.inviter === assistantId
			);
		}
		expect(invites).toHaveLength(1);
		room = invites[0]?.roomId ?? '';
		await aliceClient.joinRoom(room);
		const welcome = await aliceClient.waitForMessage(room, assistantId, (t) =>
			t.includes('Jarvis')
		);
		expect(welcome).toContain('assistant');
		expect(await h.synapse.displayName(assistantId)).toBe('Jarvis');
	});

	it('refuses a second creation and shows the existing assistant', async () => {
		expect(await ask('/newbot')).toContain('/mybot');
		const shown = await ask('/mybot');
		expect(shown).toContain('Jarvis');
		expect(shown).toContain(assistantId);
	});

	it('renames the assistant', async () => {
		expect(await ask('/rename Vision')).toContain('Vision');
		expect(await ask('/mybot')).toContain('Vision');
		expect(await h.synapse.displayName(assistantId)).toBe('Vision');
	});

	it('exposes the same operations through the API, each owner seeing only their own', async () => {
		const mine = await h.api.get<AssistantView>('alice@test.local', '/v1/assistants/me');
		expect(mine.status).toBe(200);
		expect(mine.body.name).toBe('Vision');
		expect((await h.api.get('bob@test.local', '/v1/assistants/me')).status).toBe(404);
		const created = await h.api.post<AssistantView>('bob@test.local', '/v1/assistants', {
			name: 'Friday'
		});
		expect(created.status).toBe(201);
		expect(created.body.userId).toBe('@twake-space-assistant-bob:test.local');
		expect((await h.api.post('bob@test.local', '/v1/assistants', { name: 'Again' })).status).toBe(
			409
		);
		expect(
			(await h.api.post('bob@test.local', '/v1/assistants', { name: 'x', owner: 'alice' })).status
		).toBe(400);
		const renamed = await h.api.put<AssistantView>('bob@test.local', '/v1/assistants/me', {
			name: 'Saturday'
		});
		expect(renamed.status).toBe(200);
		expect(renamed.body.name).toBe('Saturday');
		expect(
			(await h.api.get<AssistantView>('alice@test.local', '/v1/assistants/me')).body.name
		).toBe('Vision');
	});

	it('is one person for Matrix and for the API: the email is the principal', async () => {
		// The subject of the token is the owner's email; a bare localpart is somebody else
		expect((await h.api.get('alice', '/v1/assistants/me')).status).toBe(404);
		// A person of another mail domain has no account on the homeserver to open a room with
		const elsewhere = await h.api.post('dave@elsewhere.example', '/v1/assistants', {
			name: 'Nope'
		});
		expect(elsewhere.status).toBe(422);
		expect(elsewhere.body).toEqual({ error: 'owner not on the homeserver' });
	});

	it('wakes the assistant created from Matrix when an event names its owner by email', async () => {
		// The localpart alone names nobody's assistant; the event for the email, published after it,
		// is the next one the assistant tells, the queue being read in order
		await activity.publish(activityEvent({ id: 'evt-matrix-0', recipient: 'alice' }));
		await activity.publish(activityEvent({ id: 'evt-matrix-1', recipient: 'alice@test.local' }));
		const told = await aliceClient.waitForMessage(
			room,
			assistantId,
			(t) => t.includes('evt-matrix-1'),
			60_000
		);
		expect(told).toContain('A task has been assigned to me');
		expect(aliceClient.messages.some((m) => m.body.includes('evt-matrix-0'))).toBe(false);
	});

	it('deletes the assistant, which leaves the room, and lets the owner start over', async () => {
		const before = await h.api.get<AssistantView>('alice@test.local', '/v1/assistants/me');
		const room = before.body.roomId ?? '';
		expect(await ask('/delete')).toMatch(/deleted/i);
		expect((await h.api.get('alice@test.local', '/v1/assistants/me')).status).toBe(404);
		expect(await ask('/mybot')).toContain('/newbot');
		for (let i = 0; i < 40; i += 1) {
			const members = await h.synapse.joinedMembers(alice, room);
			if (!members.includes(assistantId)) break;
			await sleep(250);
		}
		expect(await h.synapse.joinedMembers(alice, room)).not.toContain(assistantId);
		const again = await h.api.post<AssistantView>('alice@test.local', '/v1/assistants', {
			name: 'Jarvis II'
		});
		expect(again.status).toBe(201);
		expect(again.body.userId).toBe(assistantId);
	});

	it('does not let another user manage my assistant', async () => {
		expect((await h.api.delete('carol@test.local', '/v1/assistants/me')).status).toBe(404);
		expect((await h.api.get<AssistantView>('alice@test.local', '/v1/assistants/me')).status).toBe(
			200
		);
	});
});
