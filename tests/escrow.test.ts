import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withPrincipal } from '../src/db/client.js';
import { findEscrow } from '../src/escrow/repository.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import type { ChatRequest } from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const SECRET_NAMES = [
	'backup_decryption_key',
	'backup_version',
	'master_key',
	'secret_storage_key',
	'secret_storage_key_content',
	'secret_storage_key_event_type',
	'self_signing_key',
	'user_signing_key'
];

interface KeysQuery {
	device_keys?: Record<
		string,
		Record<string, { signatures?: Record<string, Record<string, string>> }>
	>;
	master_keys?: Record<string, { keys: Record<string, string> }>;
	self_signing_keys?: Record<string, { keys: Record<string, string> }>;
}

describe("the escrow of an assistant's identity", () => {
	let h: MatrixTestHarness;
	let alice: MatrixUser;
	let client: E2eeClient;
	let freshClient: E2eeClient | undefined;
	let room: string;
	const assistantId = '@twake-space-assistant-alice:test.local';
	const escrowPath = 'twake-harness/assistants/alice@test.local';

	async function keysOf(userId: string): Promise<KeysQuery> {
		const res = await h.synapse.request(alice, 'POST', '/_matrix/client/v3/keys/query', {
			device_keys: { [userId]: [] }
		});
		return res.body as KeysQuery;
	}

	async function waitFor(check: () => boolean, what: string): Promise<void> {
		for (let i = 0; i < 120; i += 1) {
			if (check()) return;
			await sleep(250);
		}
		throw new Error(`${what} did not happen within 30 s`);
	}

	beforeAll(async () => {
		const dir = await mkdtemp(join(tmpdir(), 'escrow-'));
		const tokenPath = join(dir, 'token');
		await writeFile(tokenPath, 'pod-service-account-token\n');
		h = await startMatrixHarness({
			env: { ESCROW_ENABLED: 'true', OPENBAO_K8S_TOKEN_PATH: tokenPath }
		});
		alice = await h.synapse.registerUser('alice');
		await h.synapse.registerUser('bob');
		client = await startE2eeClient(h.synapse.url, alice);
		const created = await h.api.post<{ roomId: string }>('alice@test.local', '/v1/assistants', {
			name: 'Jarvis'
		});
		expect(created.status).toBe(201);
		room = created.body.roomId;
		for (let i = 0; i < 40; i += 1) {
			const invites = await h.synapse.pendingInvites(alice);
			if (invites.some((inv) => inv.roomId === room)) break;
			await sleep(250);
		}
		await client.joinRoom(room);
		await client.waitForMessage(room, assistantId, (t) => t.includes('Jarvis'));
		h.apisix.llm.script = (request: ChatRequest) => ({
			content: `echo: ${request.messages.at(-1)?.content ?? ''}`
		});
	}, 240_000);
	afterAll(async () => {
		if (freshClient !== undefined) await freshClient.stop();
		if (client !== undefined) await client.stop();
		if (h !== undefined) await h.close();
	});

	it('escrows the identity in OpenBao once the assistant speaks, and keeps references only', async () => {
		await waitFor(() => h.apisix.openbao.store.has(escrowPath), 'the escrow write');
		const secrets = h.apisix.openbao.store.get(escrowPath) ?? {};
		expect(Object.keys(secrets).sort()).toEqual(SECRET_NAMES);
		expect(
			h.apisix.openbao.calls.some((c) => c.path === '/v1/auth/kubernetes/login' && c.status === 200)
		).toBe(true);
		const record = await withPrincipal(h.db, { id: 'alice@test.local' }, (tx) =>
			findEscrow(tx, 'alice@test.local')
		);
		expect(record?.path).toBe(`secret/data/${escrowPath}`);
		expect(record?.backupVersion).toBe(secrets['backup_version']);
		// The homeserver holds the identity the escrow describes
		const keys = await keysOf(assistantId);
		expect(Object.values(keys.master_keys?.[assistantId]?.keys ?? {})).toEqual([
			record?.masterPublicKey
		]);
		// None of the secrets is in the database
		const dump =
			JSON.stringify(await h.db.sql`select * from assistant_escrow`) +
			JSON.stringify(await h.db.sql`select * from assistants`);
		for (const value of Object.values(secrets)) expect(dump).not.toContain(value);
		// Every access is logged with the principal and the operation
		const accesses = h
			.logLines()
			.filter((l) => l['msg'] === 'escrow write' || l['msg'] === 'escrow read')
			.map((l) => [l['principal'], l['operation']]);
		expect(accesses).toContainEqual(['alice@test.local', 'write']);
		expect(
			h
				.logLines()
				.some((l) => l['msg'] === 'assistant escrowed' && l['principal'] === 'alice@test.local')
		).toBe(true);
	});

	it('backs the room keys up as messages come and go', async () => {
		await client.sendText(room, 'hello');
		expect(await client.waitForMessage(room, assistantId, (t) => t === 'echo: hello')).toBe(
			'echo: hello'
		);
		await waitFor(
			() =>
				h.apisix.matrixCalls.some((c) => c.method === 'PUT' && c.path.includes('/room_keys/keys')),
			'the keys backup upload'
		);
		expect(
			h
				.logLines()
				.some((l) => l['msg'] === 'room keys backed up' && l['principal'] === 'alice@test.local')
		).toBe(true);
	});

	it('refuses the recovery of my assistant to anyone else', async () => {
		expect((await h.api.post('bob@test.local', '/v1/assistants/me/recover', {})).status).toBe(404);
		expect(h.apisix.openbao.calls.filter((c) => c.method === 'GET')).toHaveLength(0);
	});

	it('puts a new device back on the escrowed identity after the store is lost, and the owner keeps talking', async () => {
		const before = await keysOf(assistantId);
		const devicesBefore = Object.keys(before.device_keys?.[assistantId] ?? {});
		await h.restartRole({ wipeCryptoStore: true });
		// The new device does not reset the escrowed identity: it waits for the owner's recovery
		const restarted = await keysOf(assistantId);
		expect(restarted.master_keys?.[assistantId]?.keys).toEqual(
			before.master_keys?.[assistantId]?.keys
		);
		expect(
			h
				.logLines()
				.some(
					(l) =>
						l['msg'] === 'cross-signing identity escrowed, waiting for its recovery' &&
						l['owner'] === 'alice@test.local'
				)
		).toBe(true);
		const asked = await h.api.post<{ queued: boolean }>(
			'alice@test.local',
			'/v1/assistants/me/recover',
			{}
		);
		expect(asked.status).toBe(202);
		expect(asked.body.queued).toBe(true);
		// The new device tells the owner, who reads it: her client learns the device from its key share
		const notice = await client.waitForMessage(
			room,
			assistantId,
			(t) => t.includes('escrow'),
			90_000
		);
		expect(notice).toContain('My identity is back from the escrow');
		expect(
			h.logLines().some((l) => l['msg'] === 'escrow read' && l['principal'] === 'alice@test.local')
		).toBe(true);
		expect(
			h
				.logLines()
				.some((l) => l['msg'] === 'assistant recovered' && l['principal'] === 'alice@test.local')
		).toBe(true);
		const after = await keysOf(assistantId);
		// The same identity, on a new device signed with it
		expect(after.master_keys?.[assistantId]?.keys).toEqual(before.master_keys?.[assistantId]?.keys);
		const newDevices = Object.keys(after.device_keys?.[assistantId] ?? {}).filter(
			(d) => !devicesBefore.includes(d)
		);
		expect(newDevices).toHaveLength(1);
		const selfSigningKey =
			Object.values(after.self_signing_keys?.[assistantId]?.keys ?? {})[0] ?? '';
		const signatures =
			after.device_keys?.[assistantId]?.[newDevices[0] ?? '']?.signatures?.[assistantId] ?? {};
		expect(Object.keys(signatures)).toContain(`ed25519:${selfSigningKey}`);
		const record = await withPrincipal(h.db, { id: 'alice@test.local' }, (tx) =>
			findEscrow(tx, 'alice@test.local')
		);
		expect(record?.recoveredAt).not.toBeNull();
		// Only one escrow: the recovered device writes no second one
		expect(
			h.apisix.openbao.calls.filter((c) => c.method === 'POST' && c.path.includes('/secret/data/'))
		).toHaveLength(1);
		// The owner opens Twake Chat anew: her fresh session shares its keys with the signed device,
		// and the conversation goes on encrypted
		freshClient = await startE2eeClient(h.synapse.url, await h.synapse.login('alice'));
		await freshClient.sendText(room, 'still there?');
		expect(
			await freshClient.waitForMessage(room, assistantId, (t) => t === 'echo: still there?', 90_000)
		).toBe('echo: still there?');
	}, 300_000);
});
