import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/db/migrate.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient, type TestClient } from './helpers/client.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import type { ChatRequest } from './helpers/fake-apisix.js';
import { eventually } from './helpers/feedback.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import { PROVISIONER, provisioningPath, provisionUntilReady } from './helpers/provisioning.js';
import type { MatrixUser } from './helpers/synapse.js';

// The owner ToM provisions for
const OWNER = '@bob:test.local';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
		const anonymous = await h.app.inject({
			method: 'PUT',
			url: provisioningPath(OWNER),
			payload: {}
		});
		expect(anonymous.statusCode).toBe(401);

		// The owner's own token is not a provisioner's either
		const asOwner = await api.put('bob@test.local', provisioningPath(OWNER), {});
		expect(asOwner.status).toBe(403);
		expect(asOwner.body).toEqual({ error: 'not a provisioner' });
	});

	it('refuses an owner who is not a user of the homeserver', async () => {
		const elsewhere = await api.put(PROVISIONER, provisioningPath('@bob:elsewhere.example'), {});
		expect(elsewhere.status).toBe(422);
		expect(elsewhere.body).toEqual({ error: 'owner not on the homeserver' });

		const notAMatrixId = await api.put(PROVISIONER, provisioningPath('bob@test.local'), {});
		expect(notAMatrixId.status).toBe(422);
	});

	it("asks for the recovery of an owner's assistant for a provisioner only", async () => {
		const recover = `${provisioningPath(OWNER)}/recover`;
		expect((await h.app.inject({ method: 'POST', url: recover, payload: {} })).statusCode).toBe(
			401
		);
		expect((await api.post('bob@test.local', recover, {})).status).toBe(403);
		expect(
			(await api.post(PROVISIONER, `${provisioningPath('@bob:elsewhere.example')}/recover`, {}))
				.status
		).toBe(422);
		const none = await api.post(PROVISIONER, recover, {});
		expect(none.status).toBe(404);
		expect(none.body).toEqual({ error: 'no assistant' });
	});

	it("reads an owner's assistant for a provisioner only, and none for an owner without one", async () => {
		const anonymous = await h.app.inject({ method: 'GET', url: provisioningPath(OWNER) });
		expect(anonymous.statusCode).toBe(401);
		// The owner's own token is not a provisioner's either
		expect(await api.get('bob@test.local', provisioningPath(OWNER))).toEqual({
			status: 403,
			body: { error: 'not a provisioner' }
		});
		expect(await api.get(PROVISIONER, provisioningPath('@bob:elsewhere.example'))).toEqual({
			status: 422,
			body: { error: 'owner not on the homeserver' }
		});
		expect(await api.get(PROVISIONER, provisioningPath(OWNER))).toEqual({
			status: 404,
			body: { error: 'no assistant' }
		});
	});

	it("turns an owner's suggestions off and on for a provisioner only, their muted rooms kept", async () => {
		const path = `${provisioningPath('@carol:test.local')}/suggestions`;
		expect((await api.get('carol@test.local', path)).status).toBe(403);
		expect((await api.put('carol@test.local', path, { enabled: false })).status).toBe(403);
		expect((await api.put(PROVISIONER, path, { enabled: 'no' })).status).toBe(400);
		// On by default, without any assistant
		expect(await api.get(PROVISIONER, path)).toEqual({ status: 200, body: { enabled: true } });
		await api.put('carol@test.local', '/v1/suggestions/settings', {
			enabled: true,
			mutedRooms: ['!muted:test.local']
		});
		expect(await api.put(PROVISIONER, path, { enabled: false })).toEqual({
			status: 200,
			body: { enabled: false }
		});
		expect((await api.get('carol@test.local', '/v1/suggestions/settings')).body).toEqual({
			enabled: false,
			mutedRooms: ['!muted:test.local']
		});
		await api.put(PROVISIONER, path, { enabled: true });
		expect(await api.get(PROVISIONER, path)).toEqual({ status: 200, body: { enabled: true } });
	});
});

describe('a provisioned assistant', () => {
	let h: MatrixTestHarness;
	const clients: E2eeClient[] = [];

	interface ProvisionerReply {
		readonly status: number;
		readonly body: Record<string, unknown>;
		readonly retryAfter: string | undefined;
	}

	// The provisioner's call as it goes on the wire, its headers included
	async function provisionerCall(
		method: 'GET' | 'PUT',
		owner: string,
		body?: Record<string, unknown>
	): Promise<ProvisionerReply> {
		const res = await h.apps[0]!.inject({
			method,
			url: provisioningPath(owner),
			headers: { authorization: `Bearer ${await h.issuer.mint({ sub: PROVISIONER })}` },
			...(body === undefined ? {} : { payload: body })
		});
		const retryAfter = res.headers['retry-after'];
		return {
			status: res.statusCode,
			body: res.json() as Record<string, unknown>,
			retryAfter: retryAfter === undefined ? undefined : String(retryAfter)
		};
	}

	function provision(owner: string, body: Record<string, unknown> = {}): Promise<ProvisionerReply> {
		return provisionerCall('PUT', owner, body);
	}

	// What the provisioner reads of the owner's assistant, which makes none
	function readAssistant(owner: string): Promise<ProvisionerReply> {
		return provisionerCall('GET', owner);
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
		await h.synapse.request(
			bob,
			'PUT',
			`/_matrix/client/v3/profile/${encodeURIComponent(bob.userId)}/displayname`,
			{ displayname: 'Bob MARTIN' }
		);

		const first = await provision(bob.userId, { timezone: 'Europe/Paris' });
		expect(first.status).toBe(503);
		expect(first.body).toEqual({ error: 'not_ready' });
		expect(first.retryAfter).toBe('5');

		const mine = await provisionUntilReady(h.api, bob.userId);
		expect(mine.userId).toBe('@twake-space-assistant-bob:test.local');
		// Named after its owner's first name in their Matrix name, not its identifier
		expect(await h.synapse.displayName(mine.userId)).toBe("Bob's assistant");

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

	it('is read without being made: none before the provisioning, then the identity it gave', async () => {
		const ada = await h.synapse.registerUser('ada');

		expect(await readAssistant(ada.userId)).toEqual({
			status: 404,
			body: { error: 'no assistant' }
		});
		// Reading made none: its owner finds none either
		expect((await h.api.get('ada@test.local', '/v1/assistants/me')).status).toBe(404);

		const mine = await provisionUntilReady(h.api, ada.userId);
		expect(await readAssistant(ada.userId)).toEqual({ status: 200, body: mine });
	});

	it('is read as not ready while the provisioning says so, then as its identity', async () => {
		const ivy = await h.synapse.registerUser('ivy');
		// The homeserver refuses every upload of the identity while the provisioner calls
		h.apisix.matrixFault = ({ method, path }) =>
			method === 'POST' && path.startsWith('/_matrix/client/v3/keys/device_signing/upload')
				? 500
				: null;
		try {
			expect((await provision(ivy.userId)).status).toBe(503);
			expect(await readAssistant(ivy.userId)).toEqual({
				status: 503,
				body: { error: 'not_ready' },
				retryAfter: '5'
			});
		} finally {
			h.apisix.matrixFault = null;
		}

		// Read again after each 503, until the harness prepared it
		let later = await readAssistant(ivy.userId);
		for (let i = 0; i < 120 && later.status === 503; i += 1) {
			await sleep(250);
			later = await readAssistant(ivy.userId);
		}
		expect(later.status).toBe(200);
		expect(later.body).toEqual((await provision(ivy.userId)).body);
	});

	it('is prepared again when its provisioner reads it after a preparation that failed for good', async () => {
		const joy = await h.synapse.registerUser('joy');
		// The homeserver refuses every upload of the identity: the preparation fails for good
		h.apisix.matrixFault = ({ method, path }) =>
			method === 'POST' && path.startsWith('/_matrix/client/v3/keys/device_signing/upload')
				? 500
				: null;
		try {
			expect((await provision(joy.userId)).status).toBe(503);
			await sleep(12_000);
		} finally {
			h.apisix.matrixFault = null;
		}

		// Nobody provisions it again: reading it asks for its preparation, until it is ready
		let later = await readAssistant(joy.userId);
		for (let i = 0; i < 120 && later.status === 503; i += 1) {
			await sleep(250);
			later = await readAssistant(joy.userId);
		}
		expect(later.status).toBe(200);
	});

	it('is none to its provisioner once its owner deleted it, and stays deleted once read', async () => {
		const max = await h.synapse.registerUser('max');
		await provisionUntilReady(h.api, max.userId);
		expect((await h.api.delete('max@test.local', '/v1/assistants/me')).status).toBe(204);

		const none = { status: 404, body: { error: 'no assistant' } };
		expect(await readAssistant(max.userId)).toEqual(none);
		expect(await h.api.post(PROVISIONER, `${provisioningPath(max.userId)}/recover`, {})).toEqual(
			none
		);
		// Neither call brought it back: its owner finds none either
		expect((await h.api.get('max@test.local', '/v1/assistants/me')).status).toBe(404);
	});

	it('becomes ready after a failed preparation, without its provisioner calling again', async () => {
		const kim = await h.synapse.registerUser('kim');
		// The homeserver refuses the first upload of the assistant's identity
		let uploads = 0;
		h.apisix.matrixFault = ({ method, path }) =>
			method === 'POST' &&
			path.startsWith('/_matrix/client/v3/keys/device_signing/upload') &&
			uploads++ === 0
				? 500
				: null;
		try {
			const first = await provision(kim.userId);
			expect(first.status).toBe(503);
			// The harness tries again by itself: its provisioner asks once more, much later
			await sleep(12_000);
			const later = await provision(kim.userId);
			expect(later.status).toBe(200);
		} finally {
			h.apisix.matrixFault = null;
		}
		expect(uploads).toBeGreaterThan(1);
	});

	it('is prepared again when the role restarts, before it has any room', async () => {
		const lou = await h.synapse.registerUser('lou');
		// The homeserver refuses every upload of the identity: the preparation fails for good
		h.apisix.matrixFault = ({ method, path }) =>
			method === 'POST' && path.startsWith('/_matrix/client/v3/keys/device_signing/upload')
				? 500
				: null;
		try {
			expect((await provision(lou.userId)).status).toBe(503);
			await sleep(12_000);
		} finally {
			h.apisix.matrixFault = null;
		}
		await h.restartRole();
		// Nobody asks for the assistant meanwhile: the role prepares it at its start
		await sleep(5_000);
		const after = await provision(lou.userId);
		expect(after.status).toBe(200);
	});

	it('joins the direct room its owner opens and invites it to, and answers its owner there', async () => {
		const carol = await h.synapse.registerUser('carol');
		const client = await startE2eeClient(h.synapse.url, carol);
		clients.push(client);
		const mine = await provisionUntilReady(h.api, carol.userId);

		// As Twake Chat's « My assistant »: an encrypted direct room, the assistant invited. Synapse
		// pushes nothing sent before the assistant's join, so the owner writes once it is there.
		const room = await client.createDirectRoom(mine.userId);
		await h.synapse.waitForMember(carol, room, mine.userId);
		await client.sendText(room, 'hello, assistant');

		const answer = await client.waitForMessage(room, mine.userId, (text) => text.includes('echo'));
		expect(answer).toContain('hello, assistant');
	});

	// The greeting of an assistant named after its owner, whose Matrix name is their localpart here
	const greetingOf = (ownerName: string): string =>
		`Hello, I am ${ownerName}'s assistant, your Twake Space assistant. Tell me what you need; I remember what matters and I ask before I act.`;

	it('greets its owner in the first direct room they open with it, readable by their device', async () => {
		const vera = await h.synapse.registerUser('vera');
		const client = await startE2eeClient(h.synapse.url, vera);
		clients.push(client);
		const mine = await provisionUntilReady(h.api, vera.userId);

		// As Twake Chat's « My assistant »: the owner opens the room, invites the assistant, and writes
		// nothing yet
		const room = await client.createDirectRoom(mine.userId);

		const welcome = await client.waitForMessage(room, mine.userId, (text) =>
			text.startsWith('Hello')
		);
		expect(welcome).toBe(greetingOf('vera'));
		// It went through the homeserver encrypted, as everything in the room
		const greeting = client.messages.find(
			(m) => m.roomId === room && m.body === greetingOf('vera')
		);
		const raw = await h.synapse.request(
			vera,
			'GET',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=50`
		);
		const chunk = (raw.body['chunk'] ?? []) as { type: string; event_id: string }[];
		expect(chunk.find((e) => e.event_id === greeting?.eventId)?.type).toBe('m.room.encrypted');
		expect(chunk.filter((e) => e.type === 'm.room.message')).toEqual([]);
	});

	// The rooms where the owner's client read this greeting of their assistant
	function greetedIn(client: E2eeClient, assistantId: string, greeting: string): string[] {
		return client.messages
			.filter((m) => m.sender === assistantId && m.body === greeting)
			.map((m) => m.roomId);
	}

	// The help answer goes out after whatever the assistant was already saying in the room
	async function askForHelp(
		client: E2eeClient,
		roomId: string,
		assistantId: string
	): Promise<void> {
		await client.sendText(roomId, '!help');
		await client.waitForMessage(roomId, assistantId, (text) =>
			text.startsWith('I am your assistant')
		);
	}

	// Someone else comes into a room of the assistant, which then leaves it: the room is no longer
	// the one it writes its owner in
	async function bringIn(
		owner: MatrixUser,
		someone: MatrixUser,
		roomId: string,
		assistantId: string
	): Promise<void> {
		const invited = await h.synapse.request(
			owner,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
			{ user_id: someone.userId }
		);
		expect(invited.status).toBe(200);
		await membershipOf(owner, roomId, assistantId, 'leave');
	}

	// Resolves once the assistant took the room as one of its rooms, as many times as given
	async function heldAsItsRoom(roomId: string, times = 1): Promise<void> {
		const taken = await eventually(
			() =>
				h
					.logLines()
					.filter(
						(l) => l['msg'] === 'assistant room opened by its owner' && l['roomId'] === roomId
					).length >= times,
			30_000
		);
		expect(taken).toBe(true);
	}

	// The owner opens a direct room with the assistant, which the assistant then holds as its own
	async function openRoom(client: E2eeClient, assistantId: string): Promise<string> {
		const room = await client.createDirectRoom(assistantId);
		await heldAsItsRoom(room);
		return room;
	}

	// Holds the owner's assistant row, as a busy database would keep the matrix role waiting on it;
	// resolves to what releases it
	async function holdAssistantOf(owner: string): Promise<() => Promise<void>> {
		let release = (): void => undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let held = (): void => undefined;
		const holding = new Promise<void>((resolve) => {
			held = resolve;
		});
		const transaction = h.db.sql.begin(async (sql) => {
			await sql`select set_config('app.principal', ${owner}, true)`;
			await sql`select 1 from assistants where owner = ${owner} for update`;
			held();
			await released;
		});
		await holding;
		return async () => {
			release();
			await transaction;
		};
	}

	it('greets its owner before it answers them, however soon they write', async () => {
		const kate = await h.synapse.registerUser('kate');
		const client = await startE2eeClient(h.synapse.url, kate);
		clients.push(client);
		const mine = await provisionUntilReady(h.api, kate.userId);

		// The owner writes the moment the assistant joined, while the database is slow to record the
		// room as the assistant's
		const release = await holdAssistantOf('kate@test.local');
		let room: string;
		try {
			room = await client.createDirectRoom(mine.userId);
			await h.synapse.waitForMember(kate, room, mine.userId);
			const early = await client.sendText(room, '!help');
			// Until the role is done with it: answered, or dropped as a message of a room nobody holds
			await eventually(() =>
				h
					.logLines()
					.some(
						(l) =>
							(l['msg'] === 'answer sent' && l['roomId'] === room) ||
							(l['msg'] === 'room message failed' && l['eventId'] === early)
					)
			);
		} finally {
			await release();
		}

		await client.waitForMessage(room, mine.userId, (text) => text === greetingOf('kate'));
		await askForHelp(client, room, mine.userId);
		const said = client.messages.filter((m) => m.roomId === room && m.sender === mine.userId);
		expect(said[0]?.body).toBe(greetingOf('kate'));
	});

	it('greets its owner once, whatever comes after: the room named, a restart, another room', async () => {
		const wendy = await h.synapse.registerUser('wendy');
		const xavier = await h.synapse.registerUser('xavier');
		const client = await startE2eeClient(h.synapse.url, wendy);
		clients.push(client);
		const mine = await provisionUntilReady(h.api, wendy.userId);

		const first = await client.createDirectRoom(mine.userId);
		await client.waitForMessage(first, mine.userId, (text) => text === greetingOf('wendy'));
		const named = await h.api.put(PROVISIONER, `${provisioningPath(wendy.userId)}/home`, {
			roomId: first
		});
		expect(named.status).toBe(204);
		await h.restartRole();
		await askForHelp(client, first, mine.userId);
		expect(greetedIn(client, mine.userId, greetingOf('wendy'))).toEqual([first]);

		await bringIn(wendy, xavier, first, mine.userId);
		const second = await openRoom(client, mine.userId);
		await askForHelp(client, second, mine.userId);
		expect(greetedIn(client, mine.userId, greetingOf('wendy'))).toEqual([first]);
	});

	it('greets its owner once, whether they invite it again or leave for another room', async () => {
		const lena = await h.synapse.registerUser('lena');
		const omar = await h.synapse.registerUser('omar');
		const client = await startE2eeClient(h.synapse.url, lena);
		clients.push(client);
		const mine = await provisionUntilReady(h.api, lena.userId);
		const room = await openRoom(client, mine.userId);
		await client.waitForMessage(room, mine.userId, (text) => text === greetingOf('lena'));
		const roomPath = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}`;

		// Someone else comes in and the assistant leaves; the owner takes that invitation back, and
		// invites the assistant again
		await bringIn(lena, omar, room, mine.userId);
		const revoked = await h.synapse.request(lena, 'POST', `${roomPath}/kick`, {
			user_id: omar.userId
		});
		expect(revoked.status).toBe(200);
		const invited = await h.synapse.request(lena, 'POST', `${roomPath}/invite`, {
			user_id: mine.userId
		});
		expect(invited.status).toBe(200);
		await heldAsItsRoom(room, 2);
		await askForHelp(client, room, mine.userId);
		expect(greetedIn(client, mine.userId, greetingOf('lena'))).toEqual([room]);

		// The owner leaves the room, and opens another one with it
		expect((await h.synapse.request(lena, 'POST', `${roomPath}/leave`, {})).status).toBe(200);
		const other = await openRoom(client, mine.userId);
		await askForHelp(client, other, mine.userId);
		expect(greetedIn(client, mine.userId, greetingOf('lena'))).toEqual([room]);
	});

	it('greets its owner anew once they deleted it and their client asked for one again', async () => {
		const mia = await h.synapse.registerUser('mia');
		const client = await startE2eeClient(h.synapse.url, mia);
		clients.push(client);
		const mine = await provisionUntilReady(h.api, mia.userId);
		const first = await openRoom(client, mine.userId);
		await client.waitForMessage(first, mine.userId, (text) => text === greetingOf('mia'));

		expect((await h.api.delete('mia@test.local', '/v1/assistants/me')).status).toBe(204);
		const again = await provisionUntilReady(h.api, mia.userId);
		expect(again.userId).toBe(mine.userId);
		const second = await openRoom(client, again.userId);
		await client.waitForMessage(second, again.userId, (text) => text === greetingOf('mia'));
		expect(greetedIn(client, mine.userId, greetingOf('mia'))).toEqual([first, second]);
	});

	it('greets the owner who created it in the room it opened only, even once a provisioner asked for it', async () => {
		const yves = await h.synapse.registerUser('yves');
		const zoe = await h.synapse.registerUser('zoe');
		const client = await startE2eeClient(h.synapse.url, yves);
		clients.push(client);
		const created = await h.api.post<{ roomId: string; userId: string }>(
			'yves@test.local',
			'/v1/assistants',
			{ name: 'Yuki' }
		);
		expect(created.status).toBe(201);
		const { roomId: opened, userId } = created.body;
		const greeting =
			'Hello, I am Yuki, your Twake Space assistant. Tell me what you need; I remember what matters and I ask before I act.';
		const invited = await eventually(async () =>
			(await h.synapse.pendingInvites(yves)).some((invite) => invite.roomId === opened)
		);
		expect(invited).toBe(true);
		await client.joinRoom(opened);
		await client.waitForMessage(opened, userId, (text) => text === greeting);

		expect((await provisionUntilReady(h.api, yves.userId)).userId).toBe(userId);
		await bringIn(yves, zoe, opened, userId);
		const other = await openRoom(client, userId);
		await askForHelp(client, other, userId);
		expect(greetedIn(client, userId, greeting)).toEqual([opened]);
	});

	// What Twake Chat offers after « / » for the assistant (MSC4332): a state event per bot, keyed by
	// the bot's id, its descriptions as MSC1767 text
	async function announcedCommands(
		viewer: MatrixUser,
		roomId: string,
		botUserId: string,
		attempts = 40
	): Promise<unknown> {
		const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/org.matrix.msc4332.commands/${encodeURIComponent(botUserId)}`;
		for (let i = 0; i < attempts; i += 1) {
			const res = await h.synapse.request(viewer, 'GET', path);
			if (res.status === 200) return res.body;
			await sleep(250);
		}
		return null;
	}

	it('announces its commands in the direct room its owner invites it to', async () => {
		const nina = await h.synapse.registerUser('nina');
		const client = await startE2eeClient(h.synapse.url, nina);
		clients.push(client);
		const mine = await provisionUntilReady(h.api, nina.userId);

		const room = await client.createDirectRoom(mine.userId);
		await h.synapse.waitForMember(nina, room, mine.userId);

		expect(await announcedCommands(nina, room, mine.userId)).toEqual({
			commands: [
				{
					name: 'help',
					syntax: 'help',
					description: {
						'm.text': [
							{ body: 'What I can do, and how to allow or take back my access to your apps' }
						]
					}
				}
			]
		});
	});

	it('announces its commands in the room it opens itself when its owner creates it', async () => {
		const uma = await h.synapse.registerUser('uma');
		const created = await h.api.post<{ roomId: string; userId: string }>(
			'uma@test.local',
			'/v1/assistants',
			{ name: 'Ula' }
		);
		expect(created.status).toBe(201);
		for (let i = 0; i < 40; i += 1) {
			const invites = await h.synapse.pendingInvites(uma);
			if (invites.some((invite) => invite.roomId === created.body.roomId)) break;
			await sleep(250);
		}
		await h.synapse.joinRoom(uma, created.body.roomId);

		expect(await announcedCommands(uma, created.body.roomId, created.body.userId)).toMatchObject({
			commands: [{ name: 'help', syntax: 'help' }]
		});
	});

	it('announces its commands in a room the client names, once the room lets it', async () => {
		const pam = await h.synapse.registerUser('pam');
		const mine = await provisionUntilReady(h.api, pam.userId);
		const roomsPath = '/_matrix/client/v3/rooms';
		// A direct room where only its creator may announce commands: the assistant's announcement at
		// its join is refused
		const created = await h.synapse.request(pam, 'POST', '/_matrix/client/v3/createRoom', {
			is_direct: true,
			preset: 'private_chat',
			invite: [mine.userId],
			power_level_content_override: { events: { 'org.matrix.msc4332.commands': 100 } }
		});
		const room = created.body['room_id'] as string;
		await h.synapse.waitForMember(pam, room, mine.userId);
		expect(await announcedCommands(pam, room, mine.userId, 8)).toBeNull();

		// The owner lets members announce commands there, then the client names the room
		const levelsPath = `${roomsPath}/${encodeURIComponent(room)}/state/m.room.power_levels/`;
		const levels = (await h.synapse.request(pam, 'GET', levelsPath)).body as Record<
			string,
			unknown
		>;
		const events = {
			...(levels['events'] as Record<string, number>),
			'org.matrix.msc4332.commands': 0
		};
		await h.synapse.request(pam, 'PUT', levelsPath, { ...levels, events });
		const named = await h.api.put(PROVISIONER, `${provisioningPath(pam.userId)}/home`, {
			roomId: room
		});
		expect(named.status).toBe(204);

		expect(await announcedCommands(pam, room, mine.userId)).toMatchObject({
			commands: [{ name: 'help', syntax: 'help' }]
		});
	});

	it('answers !help itself, without asking the model', async () => {
		const oscar = await h.synapse.registerUser('oscar');
		const client = await startE2eeClient(h.synapse.url, oscar);
		clients.push(client);
		const mine = await provisionUntilReady(h.api, oscar.userId);
		const room = await client.createDirectRoom(mine.userId);
		await h.synapse.waitForMember(oscar, room, mine.userId);

		// As Twake Chat sends a command the assistant announced
		await client.sendText(room, '!help');

		const answer = await client.waitForMessage(room, mine.userId, (text) =>
			text.startsWith('I am your assistant')
		);
		expect(answer).toContain('Commands: !help shows this message.');
		const asked = h.apisix.llm.calls.some((call) =>
			call.request.messages.some((message) => message.content?.includes('!help') === true)
		);
		expect(asked).toBe(false);
	});

	it('takes the direct room the client names as the room it writes to its owner in', async () => {
		const dave = await h.synapse.registerUser('dave');
		const client = await startE2eeClient(h.synapse.url, dave);
		clients.push(client);
		const mine = await provisionUntilReady(h.api, dave.userId);
		const first = await client.createDirectRoom(mine.userId);
		await h.synapse.waitForMember(dave, first, mine.userId);
		// The client opens another direct room with it, and names that one
		const second = await client.createDirectRoom(mine.userId);
		await h.synapse.waitForMember(dave, second, mine.userId);

		const named = await h.api.put(PROVISIONER, `${provisioningPath(dave.userId)}/home`, {
			roomId: second
		});
		expect(named.status).toBe(204);

		const seen = await h.api.get<{ roomId: string }>('dave@test.local', '/v1/assistants/me');
		expect(seen.body.roomId).toBe(second);
	});

	// The assistant's membership of a room once it is the one expected, with its reason if any
	async function membershipOf(
		viewer: MatrixUser,
		roomId: string,
		userId: string,
		expected: string
	): Promise<Record<string, unknown>> {
		const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`;
		let content: Record<string, unknown> = {};
		for (let i = 0; i < 120; i += 1) {
			content = (await h.synapse.request(viewer, 'GET', path)).body;
			if (content['membership'] === expected) return content;
			await sleep(250);
		}
		throw new Error(`${userId} is ${String(content['membership'])} in ${roomId}, not ${expected}`);
	}

	const DIRECT_ROOMS_ONLY =
		'For now I work only in a private conversation with the person I assist, so I am leaving this room.';

	it('declines a room where others than its owner are, and says why', async () => {
		const paul = await h.synapse.registerUser('paul');
		const quinn = await h.synapse.registerUser('quinn');
		const mine = await provisionUntilReady(h.api, paul.userId);
		// Paul's room with Quinn, where he brings his assistant
		const created = await h.synapse.request(paul, 'POST', '/_matrix/client/v3/createRoom', {
			preset: 'private_chat',
			invite: [quinn.userId]
		});
		const room = created.body['room_id'] as string;
		await h.synapse.joinRoom(quinn, room);
		const invited = await h.synapse.request(
			paul,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`,
			{ user_id: mine.userId }
		);
		expect(invited.status).toBe(200);

		const left = await membershipOf(paul, room, mine.userId, 'leave');
		expect(left['reason']).toBe(DIRECT_ROOMS_ONLY);
		expect(
			h
				.logLines()
				.some(
					(l) =>
						l['msg'] === 'assistant declined an invite' &&
						l['roomId'] === room &&
						l['reason'] === 'not_direct'
				)
		).toBe(true);
	});

	it('leaves its direct room once someone else comes in, and says why', async () => {
		const sara = await h.synapse.registerUser('sara');
		const tom = await h.synapse.registerUser('tom');
		const client = await startE2eeClient(h.synapse.url, sara);
		clients.push(client);
		const mine = await provisionUntilReady(h.api, sara.userId);
		const room = await client.createDirectRoom(mine.userId);
		await h.synapse.waitForMember(sara, room, mine.userId);

		const invited = await h.synapse.request(
			sara,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`,
			{ user_id: tom.userId }
		);
		expect(invited.status).toBe(200);

		const notice = await client.waitForMessage(room, mine.userId, (text) =>
			text.includes('private conversation')
		);
		expect(notice).toBe(DIRECT_ROOMS_ONLY);
		const left = await membershipOf(sara, room, mine.userId, 'leave');
		expect(left['reason']).toBe(DIRECT_ROOMS_ONLY);
	});

	it('refuses as the room it writes to its owner in a room others came into', async () => {
		const gina = await h.synapse.registerUser('gina');
		const hank = await h.synapse.registerUser('hank');
		const client = await startE2eeClient(h.synapse.url, gina);
		clients.push(client);
		const mine = await provisionUntilReady(h.api, gina.userId);
		const room = await client.createDirectRoom(mine.userId);
		await h.synapse.waitForMember(gina, room, mine.userId);
		const invited = await h.synapse.request(
			gina,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`,
			{ user_id: hank.userId }
		);
		expect(invited.status).toBe(200);
		await h.synapse.joinRoom(hank, room);

		// Refused whether the assistant has already left the room or is about to
		const named = await h.api.put(PROVISIONER, `${provisioningPath(gina.userId)}/home`, {
			roomId: room
		});
		expect(named.status).toBe(409);
		expect(['not a member', 'not a direct room']).toContain(named.body['error']);
	});

	it('declines a room someone other than its owner invites it to', async () => {
		const frank = await h.synapse.registerUser('frank');
		const mallory = await h.synapse.registerUser('mallory');
		const mine = await provisionUntilReady(h.api, frank.userId);

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

	it('refuses a room for an owner without assistant, and a room the assistant is not in', async () => {
		const erin = await h.synapse.registerUser('erin');
		const alone = await h.synapse.createDirectRoom(erin, '@nobody:test.local');

		const noAssistant = await h.api.put(PROVISIONER, `${provisioningPath(erin.userId)}/home`, {
			roomId: alone
		});
		expect(noAssistant.status).toBe(404);
		expect(noAssistant.body).toEqual({ error: 'no assistant' });

		await provisionUntilReady(h.api, erin.userId);
		const notMember = await h.api.put(PROVISIONER, `${provisioningPath(erin.userId)}/home`, {
			roomId: alone
		});
		expect(notMember.status).toBe(409);
		expect(notMember.body).toEqual({ error: 'not a member' });
	});

	it('owes no greeting when it was provisioned before the greeting was', async () => {
		const nora = await h.synapse.registerUser('nora');
		const client = await startE2eeClient(h.synapse.url, nora);
		clients.push(client);
		const mine = await provisionUntilReady(h.api, nora.userId);
		// The database as it stood before, the assistant provisioned and without a room, brought up to
		// date. Nothing there tells an assistant that never had a room from one whose rooms were all
		// left, which would then greet its owner twice.
		await h.db.sql`alter table assistant_provisioned drop column owes_welcome`;
		await h.db
			.sql`delete from schema_migrations where name = '0053_assistant_provisioned_welcome.sql'`;
		expect((await runMigrations(h.db)).applied).toEqual(['0053_assistant_provisioned_welcome.sql']);

		const room = await openRoom(client, mine.userId);
		await askForHelp(client, room, mine.userId);
		expect(greetedIn(client, mine.userId, greetingOf('nora'))).toEqual([]);
	});
});

describe('a provisioned assistant whose identity waits for its recovery', () => {
	let h: MatrixTestHarness;

	async function provision(
		owner: string
	): Promise<{ status: number; body: Record<string, unknown> }> {
		const res = await h.apps[0]!.inject({
			method: 'PUT',
			url: provisioningPath(owner),
			headers: { authorization: `Bearer ${await h.issuer.mint({ sub: PROVISIONER })}` },
			payload: {}
		});
		return { status: res.statusCode, body: res.json() as Record<string, unknown> };
	}

	async function provisionUntil(owner: string, status: number): Promise<Record<string, unknown>> {
		for (let i = 0; i < 160; i += 1) {
			const res = await provision(owner);
			if (res.status === status) return res.body;
			await sleep(250);
		}
		throw new Error(`the provisioning never answered ${status}`);
	}

	beforeAll(async () => {
		const dir = await mkdtemp(join(tmpdir(), 'provisioning-escrow-'));
		const tokenPath = join(dir, 'token');
		await writeFile(tokenPath, 'pod-service-account-token\n');
		h = await startMatrixHarness({
			env: {
				PROVISIONER_CLIENT_IDS: PROVISIONER,
				ESCROW_ENABLED: 'true',
				OPENBAO_K8S_TOKEN_PATH: tokenPath
			}
		});
	}, 240_000);
	afterAll(async () => {
		if (h !== undefined) await h.close();
	});

	it('tells its provisioner the owner must recover it, then gives its identity again once they did', async () => {
		const rita = await h.synapse.registerUser('rita');
		const before = await provisionUntil(rita.userId, 200);
		// The identity is escrowed, then the role loses its store
		for (let i = 0; i < 120; i += 1) {
			if (h.apisix.openbao.store.has('twake-harness/assistants/rita@test.local')) break;
			await sleep(250);
		}
		await h.restartRole({ wipeCryptoStore: true });

		expect(await provisionUntil(rita.userId, 409)).toEqual({ error: 'recovery_needed' });
		// Asking again changes nothing: only the owner's recovery brings the identity back
		expect((await provision(rita.userId)).status).toBe(409);
		// Reading it answers as the provisioning does
		const read = await h.api.get(PROVISIONER, provisioningPath(rita.userId));
		expect(read).toEqual({ status: 409, body: { error: 'recovery_needed' } });

		// The provisioner asks for it on the owner's behalf, as the owner would
		expect(await h.api.post(PROVISIONER, `${provisioningPath(rita.userId)}/recover`, {})).toEqual({
			status: 202,
			body: { queued: true }
		});
		const after = await provisionUntil(rita.userId, 200);
		expect(after['masterKey']).toBe(before['masterKey']);
		expect(after['deviceId']).not.toBe(before['deviceId']);
		const readAfter = await h.api.get(PROVISIONER, provisioningPath(rita.userId));
		expect(readAfter).toEqual({ status: 200, body: after });
	});

	it('has its recovery queued again after one that failed for good, whoever asks for it', async () => {
		const ned = await h.synapse.registerUser('ned');
		const fay = await h.synapse.registerUser('fay');
		const before = [await provisionUntil(ned.userId, 200), await provisionUntil(fay.userId, 200)];
		// Both identities are escrowed, then the role loses its store
		const escrowed = ['ned@test.local', 'fay@test.local'].map(
			(owner) => `twake-harness/assistants/${owner}`
		);
		for (let i = 0; i < 120; i += 1) {
			if (escrowed.every((path) => h.apisix.openbao.store.has(path))) break;
			await sleep(250);
		}
		await h.restartRole({ wipeCryptoStore: true });
		await provisionUntil(ned.userId, 409);
		await provisionUntil(fay.userId, 409);

		// Its provisioner asks for it on the owner's behalf, or the owner themselves
		const askedByProvisioner = `${provisioningPath(ned.userId)}/recover`;
		const queued = { status: 202, body: { queued: true } };
		// The homeserver refuses the signature of the recovered device: both recoveries fail for good
		h.apisix.matrixFault = ({ method, path }) =>
			method === 'POST' && path.startsWith('/_matrix/client/v3/keys/signatures/upload')
				? 500
				: null;
		try {
			expect(await h.api.post(PROVISIONER, askedByProvisioner, {})).toEqual(queued);
			expect(await h.api.post('fay@test.local', '/v1/assistants/me/recover', {})).toEqual(queued);
			await sleep(12_000);
		} finally {
			h.apisix.matrixFault = null;
		}

		// Asked again, each recovery is queued anew and brings the identity back
		expect(await h.api.post(PROVISIONER, askedByProvisioner, {})).toEqual(queued);
		expect(await h.api.post('fay@test.local', '/v1/assistants/me/recover', {})).toEqual(queued);
		const after = [await provisionUntil(ned.userId, 200), await provisionUntil(fay.userId, 200)];
		expect(after.map((identity) => identity['masterKey'])).toEqual(
			before.map((identity) => identity['masterKey'])
		);
	});
});
