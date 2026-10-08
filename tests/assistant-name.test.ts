import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import { PROVISIONER, provisioningPath } from './helpers/provisioning.js';

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
	async function provisioned(localpart: string, displayName: string): Promise<AssistantView> {
		const owner = await h.synapse.registerUser(localpart, displayName);
		const asked = await h.api.put(PROVISIONER, provisioningPath(owner.userId), {});
		expect([200, 503]).toContain(asked.status);
		const mine = await h.api.get<AssistantView>(`${localpart}@test.local`, '/v1/assistants/me');
		expect(mine.status).toBe(200);
		return mine.body;
	}

	it("takes its owner's first name, the words before the first one in capitals", async () => {
		expect((await provisioned('michel', 'Michel-Marie MAUDET')).name).toBe(
			"Michel-Marie's assistant"
		);
	});

	it('keeps the first 64 characters of a long name, none of them cut in half', async () => {
		const name = (await provisioned('ines', `Inès ${'😀'.repeat(70)}`)).name;
		expect(name).toBe(`Inès ${'😀'.repeat(59)}`);
	});

	it("takes its owner's identifier when their name holds what a name of an assistant cannot", async () => {
		// The technologist emoji joins its two halves with a format character
		expect((await provisioned('zoe', 'Zoé 👩‍💻')).name).toBe("zoe's assistant");
	});
});
