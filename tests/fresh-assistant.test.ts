import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import type { ChatRequest } from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The harness reaches Synapse through the matrix route of APISIX only, which sets the application
// service token on every request: an assistant that has never spoken must set its encryption up
// all the same, as the first assistant of a colleague did not on dev.
describe('a new assistant behind the gateway', () => {
	let h: MatrixTestHarness;
	const clients: E2eeClient[] = [];

	// The owner creates an assistant through the API, joins the room it opens, and reads the welcome
	async function meetNewAssistant(
		localpart: string,
		name: string
	): Promise<{ client: E2eeClient; room: string; assistantId: string; welcome: string }> {
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
		const welcome = await client.waitForMessage(room, assistantId, (t) => t.includes(name));
		return { client, room, assistantId, welcome };
	}

	async function devicesOf(userId: string): Promise<string[]> {
		const res = await h.synapse.request(
			{ userId: '', accessToken: h.config.matrix.asToken },
			'GET',
			`/_matrix/client/v3/devices?user_id=${encodeURIComponent(userId)}`
		);
		expect(res.status).toBe(200);
		return ((res.body['devices'] ?? []) as { device_id: string }[]).map((d) => d.device_id);
	}

	function setupFailuresOf(userId: string): Record<string, unknown>[] {
		return h
			.logLines()
			.filter((l) => l['msg'] === 'encryption setup failed' && l['userId'] === userId);
	}

	beforeAll(async () => {
		h = await startMatrixHarness();
		h.apisix.llm.script = (request: ChatRequest) => ({
			content: `echo: ${request.messages.at(-1)?.content ?? ''}`
		});
	}, 240_000);
	afterAll(async () => {
		for (const client of clients) await client.stop();
		if (h !== undefined) await h.close();
	});

	it('reaches Synapse as the application service, whatever token the caller sends', async () => {
		const res = await fetch(`${h.apisix.baseUrl}/matrix/_matrix/client/v3/account/whoami`, {
			headers: { apikey: h.apisix.consumerKey, authorization: 'Bearer a-device-token' }
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body['user_id']).toBe(h.role.creatorUserId);
		expect(body['device_id']).toBeUndefined();
	});

	it('sets its encryption up from nothing: the welcome comes, the owner is read and answered', async () => {
		const { client, room, assistantId, welcome } = await meetNewAssistant('paul', 'Ada');
		expect(welcome).toContain('Ada');
		await client.sendText(room, 'hello');
		expect(await client.waitForMessage(room, assistantId, (t) => t.startsWith('echo:'))).toBe(
			'echo: hello'
		);
		// It speaks from one device of its own, which the homeserver knows
		const deviceId =
			h.role.appservice.getIntentForUserId(assistantId).underlyingClient.crypto?.clientDeviceId;
		expect(await devicesOf(assistantId)).toEqual([deviceId]);
		expect(setupFailuresOf(assistantId)).toEqual([]);
	});

	it('sets its encryption up again after a failed attempt, instead of failing every message', async () => {
		const assistantId = '@twake-space-assistant-rita:test.local';
		// The homeserver fails the first check of the device the new assistant speaks from
		let failed = 0;
		h.apisix.matrixFault = (call) => {
			const target = new URL(call.path, 'http://synapse');
			if (
				failed === 0 &&
				target.pathname === '/_matrix/client/v3/account/whoami' &&
				target.searchParams.get('user_id') === assistantId
			) {
				failed += 1;
				return 500;
			}
			return null;
		};
		try {
			const { client, room, welcome } = await meetNewAssistant('rita', 'Bea');
			expect(welcome).toContain('Bea');
			await client.sendText(room, 'still there?');
			expect(await client.waitForMessage(room, assistantId, (t) => t.startsWith('echo:'))).toBe(
				'echo: still there?'
			);
		} finally {
			h.apisix.matrixFault = null;
		}
		expect(failed).toBe(1);
		const failures = setupFailuresOf(assistantId);
		expect(failures).toHaveLength(1);
		// What failed and where, never what the homeserver answered nor a token
		expect(JSON.stringify(failures)).not.toContain(h.config.matrix.asToken);
	});
});
