import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { eventually } from './helpers/feedback.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import { PROVISIONER, provisioningPath } from './helpers/provisioning.js';
import type { MatrixUser } from './helpers/synapse.js';

interface AssistantView {
	readonly userId: string;
	readonly name: string;
	readonly roomId: string | null;
}

describe('an assistant named after its owner, on a homeserver that refuses display-name changes', () => {
	let h: MatrixTestHarness;

	beforeAll(async () => {
		h = await startMatrixHarness({
			env: { PROVISIONER_CLIENT_IDS: PROVISIONER },
			// As the platform's homeserver: nobody changes the display name of their profile
			synapse: { enable_set_displayname: false }
		});
	}, 240_000);
	afterAll(async () => {
		if (h !== undefined) await h.close();
	});

	// The owner's assistant as a provisioner asks for it, then as its owner reads it
	async function provisioned(
		localpart: string,
		displayName: string
	): Promise<{ owner: MatrixUser; assistant: AssistantView }> {
		const owner = await h.synapse.registerUser(localpart, displayName);
		const asked = await h.api.put(PROVISIONER, provisioningPath(owner.userId), {});
		expect([200, 503]).toContain(asked.status);
		const mine = await h.api.get<AssistantView>(`${localpart}@test.local`, '/v1/assistants/me');
		expect(mine.status).toBe(200);
		return { owner, assistant: mine.body };
	}

	// The name the assistant goes by in the room, as its owner's client reads it: once it is the one
	// expected, or else when the time is up
	async function nameShown(
		owner: MatrixUser,
		roomId: string,
		assistantId: string,
		expected: string
	): Promise<unknown> {
		const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(assistantId)}`;
		let shown: unknown = null;
		await eventually(async () => {
			shown = (await h.synapse.request(owner, 'GET', path)).body['displayname'];
			return shown === expected;
		});
		return shown;
	}

	it("takes its owner's first name, the words before the first one in capitals", async () => {
		const { assistant } = await provisioned('michel', 'Michel-Marie MAUDET');
		expect(assistant.name).toBe("Michel-Marie's assistant");
	});

	it('keeps the first 64 characters of a long name, none of them cut in half', async () => {
		const { assistant } = await provisioned('ines', `Inès ${'😀'.repeat(70)}`);
		expect(assistant.name).toBe(`Inès ${'😀'.repeat(59)}`);
	});

	it("takes its owner's identifier when their name holds what a name of an assistant cannot", async () => {
		// The technologist emoji joins its two halves with a format character
		const { assistant } = await provisioned('zoe', 'Zoé 👩‍💻');
		expect(assistant.name).toBe("zoe's assistant");
	});

	it('goes by its name in the room its owner opens with it', async () => {
		const { owner, assistant } = await provisioned('nina', 'Nina SIMONE');
		const room = await h.synapse.createDirectRoom(owner, assistant.userId);
		expect(await nameShown(owner, room, assistant.userId, "Nina's assistant")).toBe(
			"Nina's assistant"
		);
	});

	it('goes by the name its owner chose in the room it opens with them', async () => {
		const owner = await h.synapse.registerUser('paul', 'Paul VALÉRY');
		const created = await h.api.post<AssistantView>('paul@test.local', '/v1/assistants', {
			name: 'Friday'
		});
		expect(created.status).toBe(201);
		const room = created.body.roomId ?? '';
		await h.synapse.joinRoom(owner, room);
		expect(await nameShown(owner, room, created.body.userId, 'Friday')).toBe('Friday');
	});

	it('goes by each name its owner gives it in their room', async () => {
		const { owner, assistant } = await provisioned('omar', 'Omar SY');
		const room = await h.synapse.createDirectRoom(owner, assistant.userId);
		expect(await nameShown(owner, room, assistant.userId, "Omar's assistant")).toBe(
			"Omar's assistant"
		);

		for (const name of ['Jarvis', 'Vision']) {
			const renamed = await h.api.put('omar@test.local', '/v1/assistants/me', { name });
			expect(renamed.status).toBe(200);
			expect(await nameShown(owner, room, assistant.userId, name)).toBe(name);
		}
	});
});
