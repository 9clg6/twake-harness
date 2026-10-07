import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient, type TestClient } from './helpers/client.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import type { ChatRequest } from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

// The service client ToM gets its tokens as, and the owner it provisions for
const PROVISIONER = 'tom-bots';
const OWNER = '@bob:test.local';

function assistantPath(owner: string): string {
	return `/v1/provisioning/assistants/${encodeURIComponent(owner)}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MyAssistant {
	readonly userId: string;
	readonly deviceId: string;
	readonly masterKey: string;
}

interface KeysQuery {
	device_keys?: Record<
		string,
		Record<string, { signatures?: Record<string, Record<string, string>> }>
	>;
	master_keys?: Record<string, { keys: Record<string, string> }>;
	self_signing_keys?: Record<string, { keys: Record<string, string> }>;
}

describe('the provisioning API admits its provisioners only', () => {
	let h: TestHarness;
	let api: TestClient;

	beforeAll(async () => {
		h = await startTestHarness({
			env: {
				PROVISIONER_CLIENT_IDS: `${PROVISIONER}, other-provisioner`,
				MATRIX_SERVER_NAME: 'test.local'
			}
		});
		api = makeClient(h);
	});
	afterAll(async () => {
		if (h !== undefined) await h.close();
	});

	it("refuses a call without a token, and a token that is not a provisioner's", async () => {
		const anonymous = await h.app.inject({ method: 'PUT', url: assistantPath(OWNER), payload: {} });
		expect(anonymous.statusCode).toBe(401);

		// The owner's own token is not a provisioner's either
		const asOwner = await api.put('bob@test.local', assistantPath(OWNER), {});
		expect(asOwner.status).toBe(403);
		expect(asOwner.body).toEqual({ error: 'not a provisioner' });
	});

	it('refuses an owner who is not a user of the homeserver', async () => {
		const elsewhere = await api.put(PROVISIONER, assistantPath('@bob:elsewhere.example'), {});
		expect(elsewhere.status).toBe(422);
		expect(elsewhere.body).toEqual({ error: 'owner not on the homeserver' });

		const notAMatrixId = await api.put(PROVISIONER, assistantPath('bob@test.local'), {});
		expect(notAMatrixId.status).toBe(422);
	});
});

describe('a provisioned assistant', () => {
	let h: MatrixTestHarness;
	const clients: E2eeClient[] = [];

	// The provisioner's call as it goes on the wire, its headers included
	async function provision(
		owner: string,
		body: Record<string, unknown> = {}
	): Promise<{ status: number; body: Record<string, unknown>; retryAfter: string | undefined }> {
		const res = await h.apps[0]!.inject({
			method: 'PUT',
			url: assistantPath(owner),
			headers: { authorization: `Bearer ${await h.issuer.mint({ sub: PROVISIONER })}` },
			payload: body
		});
		const retryAfter = res.headers['retry-after'];
		return {
			status: res.statusCode,
			body: res.json() as Record<string, unknown>,
			retryAfter: retryAfter === undefined ? undefined : String(retryAfter)
		};
	}

	async function provisionerPut(
		url: string,
		body: Record<string, unknown>
	): Promise<{ status: number; body: Record<string, unknown> }> {
		const res = await h.apps[0]!.inject({
			method: 'PUT',
			url,
			headers: { authorization: `Bearer ${await h.issuer.mint({ sub: PROVISIONER })}` },
			payload: body
		});
		return {
			status: res.statusCode,
			body: res.body.length === 0 ? {} : (res.json() as Record<string, unknown>)
		};
	}

	// What the owner's client gets once it asks again after a 503, as ToM tells it to
	async function provisionUntilReady(owner: string): Promise<MyAssistant> {
		for (let i = 0; i < 120; i += 1) {
			const res = await provision(owner);
			if (res.status === 200) return res.body as unknown as MyAssistant;
			expect(res.status).toBe(503);
			await sleep(250);
		}
		throw new Error('the assistant never became ready');
	}

	async function waitForMember(viewer: MatrixUser, roomId: string, userId: string): Promise<void> {
		for (let i = 0; i < 80; i += 1) {
			if ((await h.synapse.joinedMembers(viewer, roomId)).includes(userId)) return;
			await sleep(250);
		}
		throw new Error(`${userId} never joined ${roomId}`);
	}

	async function keysOf(viewer: MatrixUser, userId: string): Promise<KeysQuery> {
		const res = await h.synapse.request(viewer, 'POST', '/_matrix/client/v3/keys/query', {
			device_keys: { [userId]: [] }
		});
		return res.body as KeysQuery;
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

	it('is not ready at first, then is the identity the homeserver publishes, the same on every call', async () => {
		const bob = await h.synapse.registerUser('bob');

		const first = await provision(bob.userId, { timezone: 'Europe/Paris' });
		expect(first.status).toBe(503);
		expect(first.body).toEqual({ error: 'not_ready' });
		expect(first.retryAfter).toBe('5');

		const mine = await provisionUntilReady(bob.userId);
		expect(mine.userId).toBe('@twake-space-assistant-bob:test.local');

		// What the owner's client compares before it trusts the assistant
		const keys = await keysOf(bob, mine.userId);
		expect(Object.values(keys.master_keys?.[mine.userId]?.keys ?? {})).toEqual([mine.masterKey]);
		const selfSigningKey = Object.values(keys.self_signing_keys?.[mine.userId]?.keys ?? {})[0];
		expect(selfSigningKey).toBeDefined();
		const signatures = keys.device_keys?.[mine.userId]?.[mine.deviceId]?.signatures?.[mine.userId];
		expect(signatures?.[`ed25519:${selfSigningKey}`]).toBeDefined();

		const again = await provision(bob.userId);
		expect(again.status).toBe(200);
		expect(again.body).toEqual(mine);
	});

	it('joins the direct room its owner opens and invites it to, and answers its owner there', async () => {
		const carol = await h.synapse.registerUser('carol');
		const client = await startE2eeClient(h.synapse.url, carol);
		clients.push(client);
		const mine = await provisionUntilReady(carol.userId);

		// As Twake Chat's « My assistant »: an encrypted direct room, the assistant invited. Synapse
		// pushes nothing sent before the assistant's join, so the owner writes once it is there.
		const room = await client.createDirectRoom(mine.userId);
		await waitForMember(carol, room, mine.userId);
		await client.sendText(room, 'hello, assistant');

		const answer = await client.waitForMessage(room, mine.userId, (text) => text.includes('echo'));
		expect(answer).toContain('hello, assistant');
	});

	it('takes the direct room the client names as the room it writes to its owner in', async () => {
		const dave = await h.synapse.registerUser('dave');
		const client = await startE2eeClient(h.synapse.url, dave);
		clients.push(client);
		const mine = await provisionUntilReady(dave.userId);
		const first = await client.createDirectRoom(mine.userId);
		await waitForMember(dave, first, mine.userId);
		// The client opens another direct room with it, and names that one
		const second = await client.createDirectRoom(mine.userId);
		await waitForMember(dave, second, mine.userId);

		const named = await provisionerPut(`${assistantPath(dave.userId)}/home`, { roomId: second });
		expect(named.status).toBe(204);

		const seen = await h.api.get<{ roomId: string }>('dave@test.local', '/v1/assistants/me');
		expect(seen.body.roomId).toBe(second);
	});

	it('refuses as the room it writes to its owner in a room where others are too', async () => {
		const gina = await h.synapse.registerUser('gina');
		const hank = await h.synapse.registerUser('hank');
		const client = await startE2eeClient(h.synapse.url, gina);
		clients.push(client);
		const mine = await provisionUntilReady(gina.userId);
		const room = await client.createDirectRoom(mine.userId);
		await waitForMember(gina, room, mine.userId);
		const invited = await h.synapse.request(
			gina,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`,
			{ user_id: hank.userId }
		);
		expect(invited.status).toBe(200);
		await h.synapse.joinRoom(hank, room);

		const named = await provisionerPut(`${assistantPath(gina.userId)}/home`, { roomId: room });
		expect(named.status).toBe(409);
		expect(named.body).toEqual({ error: 'not a direct room' });
	});

	it('declines a room someone other than its owner invites it to', async () => {
		const frank = await h.synapse.registerUser('frank');
		const mallory = await h.synapse.registerUser('mallory');
		const mine = await provisionUntilReady(frank.userId);

		const room = await h.synapse.createDirectRoom(mallory, mine.userId);

		let membership: unknown = 'invite';
		for (let i = 0; i < 80 && membership === 'invite'; i += 1) {
			await sleep(250);
			const state = await h.synapse.request(
				mallory,
				'GET',
				`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.room.member/${encodeURIComponent(mine.userId)}`
			);
			membership = state.body['membership'];
		}
		expect(membership).toBe('leave');
		expect(
			h.logLines().some((l) => l['msg'] === 'assistant declined an invite' && l['roomId'] === room)
		).toBe(true);
	});

	it("declines a room another owner's assistant already answers in", async () => {
		const ivan = await h.synapse.registerUser('ivan');
		const judy = await h.synapse.registerUser('judy');
		const ivanClient = await startE2eeClient(h.synapse.url, ivan);
		clients.push(ivanClient);
		const ivans = await provisionUntilReady(ivan.userId);
		const judys = await provisionUntilReady(judy.userId);
		const room = await ivanClient.createDirectRoom(ivans.userId);
		await waitForMember(ivan, room, ivans.userId);
		const invited = await h.synapse.request(
			ivan,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`,
			{ user_id: judy.userId }
		);
		expect(invited.status).toBe(200);
		await h.synapse.joinRoom(judy, room);

		// Judy brings her own assistant into Ivan's room: one assistant answers in a room
		const brought = await h.synapse.request(
			judy,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`,
			{ user_id: judys.userId }
		);
		expect(brought.status).toBe(200);
		let membership: unknown = 'invite';
		for (let i = 0; i < 80 && membership === 'invite'; i += 1) {
			await sleep(250);
			const state = await h.synapse.request(
				judy,
				'GET',
				`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.room.member/${encodeURIComponent(judys.userId)}`
			);
			membership = state.body['membership'];
		}
		expect(membership).toBe('leave');

		// Ivan's assistant still answers him there
		await ivanClient.sendText(room, 'still mine?');
		const answer = await ivanClient.waitForMessage(room, ivans.userId, (text) =>
			text.includes('still mine?')
		);
		expect(answer).toContain('echo');
	});

	it('refuses a room for an owner without assistant, and a room the assistant is not in', async () => {
		const erin = await h.synapse.registerUser('erin');
		const alone = await h.synapse.createDirectRoom(erin, '@nobody:test.local');

		const noAssistant = await provisionerPut(`${assistantPath(erin.userId)}/home`, {
			roomId: alone
		});
		expect(noAssistant.status).toBe(404);
		expect(noAssistant.body).toEqual({ error: 'no assistant' });

		await provisionUntilReady(erin.userId);
		const notMember = await provisionerPut(`${assistantPath(erin.userId)}/home`, {
			roomId: alone
		});
		expect(notMember.status).toBe(409);
		expect(notMember.body).toEqual({ error: 'not a member' });
	});
});
