import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ProvisionedBot {
	userId: string;
	deviceId: string;
	masterKey: string;
}

const ALICE = '@alice:test.local';
const ASSISTANT = '@twake-space-assistant-alice:test.local';
const PATH = `/v1/provisioning/assistants/${encodeURIComponent(ALICE)}`;

describe('ToM provisions the assistant of a Twake Chat user', () => {
	let h: MatrixTestHarness;
	let alice: MatrixUser;
	let aliceClient: E2eeClient;
	beforeAll(async () => {
		h = await startMatrixHarness({ env: { PROVISIONING_CLIENT_IDS: 'tom' } });
		alice = await h.synapse.registerUser('alice');
		aliceClient = await startE2eeClient(h.synapse.url, alice);
	}, 180_000);
	afterAll(async () => {
		if (aliceClient !== undefined) await aliceClient.stop();
		if (h !== undefined) await h.close();
	});

	// Asks as the client does: again while the harness answers 503
	async function provision(): Promise<ProvisionedBot> {
		for (let i = 0; i < 60; i += 1) {
			const reply = await h.api.put<ProvisionedBot>('tom', PATH, { timezone: 'Europe/Paris' });
			if (reply.status === 200) return reply.body;
			expect(reply.status).toBe(503);
			await sleep(1000);
		}
		throw new Error('the assistant was never ready');
	}

	it('refuses a client the settings do not name, and a user', async () => {
		expect((await h.api.put('dispatcher', PATH, {})).status).toBe(403);
		expect((await h.api.put('alice@test.local', PATH, {})).status).toBe(403);
	});

	it('refuses an owner of another homeserver', async () => {
		const other = `/v1/provisioning/assistants/${encodeURIComponent('@bob:elsewhere.org')}`;
		expect((await h.api.put('tom', other, {})).status).toBe(422);
	});

	it('answers the bot once its device is signed, with the identity clients see', async () => {
		const bot = await provision();
		expect(bot.userId).toBe(ASSISTANT);
		const keys = await h.synapse.request(alice, 'POST', '/_matrix/client/v3/keys/query', {
			device_keys: { [ASSISTANT]: [] }
		});
		const body = keys.body as {
			master_keys?: Record<string, { keys?: Record<string, string> }>;
			device_keys?: Record<string, Record<string, unknown>>;
		};
		expect(Object.values(body.master_keys?.[ASSISTANT]?.keys ?? {})).toContain(bot.masterKey);
		expect(Object.keys(body.device_keys?.[ASSISTANT] ?? {})).toContain(bot.deviceId);
		// Idempotent, with no room opened by the harness
		expect(await provision()).toEqual(bot);
		expect(await h.synapse.pendingInvites(alice)).toEqual([]);
	}, 90_000);

	it('takes the room the client opened as the home of the assistant once it joined', async () => {
		expect((await h.api.put('tom', `${PATH}/home`, { roomId: '!nowhere:test.local' })).status).toBe(
			409
		);
		const roomId = await aliceClient.createDirectRoom(ASSISTANT);
		let status = 0;
		for (let i = 0; i < 30 && status !== 204; i += 1) {
			status = (await h.api.put('tom', `${PATH}/home`, { roomId })).status;
			if (status !== 204) await sleep(1000);
		}
		expect(status).toBe(204);
		const rows = await h.db.sql<{ owner: string; user_id: string }[]>`
			select owner, user_id from assistant_rooms where room_id = ${roomId}`;
		expect(rows).toEqual([{ owner: 'alice@test.local', user_id: ASSISTANT }]);
	}, 60_000);

	it('answers 404 home for an owner without an assistant', async () => {
		await h.synapse.registerUser('carol');
		const carol = `/v1/provisioning/assistants/${encodeURIComponent('@carol:test.local')}/home`;
		expect((await h.api.put('tom', carol, { roomId: '!x:test.local' })).status).toBe(404);
	});
});
