import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import type { ChatRequest } from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

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

// The canonical JSON Matrix signs: keys sorted, no whitespace
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0
		);
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function unpaddedBase64(bytes: Buffer): string {
	return bytes.toString('base64').replace(/=+$/, '');
}

interface Ed25519Key {
	readonly publicKey: string;
	sign(object: Record<string, unknown>): string;
}

// An ed25519 key the harness never sees, as another application would hold it
function makeEd25519Key(): Ed25519Key {
	const pair = generateKeyPairSync('ed25519');
	const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
	return {
		publicKey: unpaddedBase64(raw),
		sign: (object) =>
			unpaddedBase64(sign(null, Buffer.from(canonicalJson(object)), pair.privateKey))
	};
}

describe("an assistant's cross-signing identity", () => {
	let h: MatrixTestHarness;
	const clients: E2eeClient[] = [];

	async function keysOf(viewer: MatrixUser, userId: string): Promise<KeysQuery> {
		const res = await h.synapse.request(viewer, 'POST', '/_matrix/client/v3/keys/query', {
			device_keys: { [userId]: [] }
		});
		return res.body as KeysQuery;
	}

	// What Twake Chat checks before it sends the room keys: every device of the assistant carries
	// a signature from the assistant's self-signing key
	function devicesSignedBySelfSigningKey(keys: KeysQuery, userId: string): boolean {
		const selfSigningKey = Object.values(keys.self_signing_keys?.[userId]?.keys ?? {})[0];
		const devices = Object.values(keys.device_keys?.[userId] ?? {});
		if (selfSigningKey === undefined || devices.length === 0) return false;
		return devices.every(
			(device) => `ed25519:${selfSigningKey}` in (device.signatures?.[userId] ?? {})
		);
	}

	// The owner creates an assistant through the API and opens the room it invites them to
	async function createAssistant(
		localpart: string,
		name: string
	): Promise<{ owner: MatrixUser; client: E2eeClient; room: string; assistantId: string }> {
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
		return { owner, client, room, assistantId };
	}

	function resetsOf(owner: string): Record<string, unknown>[] {
		return h
			.logLines()
			.filter((l) => l['msg'] === 'cross-signing identity reset' && l['owner'] === owner);
	}

	beforeAll(async () => {
		// The escrow is off, as on a platform whose OpenBao is not wired yet
		h = await startMatrixHarness();
		h.apisix.llm.script = (request: ChatRequest) => ({
			content: `echo: ${request.messages.at(-1)?.content ?? ''}`
		});
	}, 240_000);
	afterAll(async () => {
		for (const client of clients) await client.stop();
		if (h !== undefined) await h.close();
	});

	it('signs a new assistant device with its own identity, escrow or not, and keeps it as the owner talks', async () => {
		const { owner, client, room, assistantId } = await createAssistant('alice', 'Jarvis');
		const keys = await keysOf(owner, assistantId);
		const master = Object.values(keys.master_keys?.[assistantId]?.keys ?? {});
		expect(master).toHaveLength(1);
		expect(devicesSignedBySelfSigningKey(keys, assistantId)).toBe(true);
		expect(resetsOf('alice@test.local').map((l) => l['replaced'])).toEqual([false]);

		// Each answer checks the identity again, and finds it in place
		await client.sendText(room, 'hello');
		expect(await client.waitForMessage(room, assistantId, (t) => t === 'echo: hello')).toBe(
			'echo: hello'
		);
		const after = await keysOf(owner, assistantId);
		expect(Object.values(after.master_keys?.[assistantId]?.keys ?? {})).toEqual(master);
		expect(resetsOf('alice@test.local')).toHaveLength(1);
	}, 120_000);

	it('replaces an identity it does not hold, as Hermes left on its Matrix user, and signs its device', async () => {
		// Another application registered the assistant's Matrix user first, and uploaded an identity
		// whose private keys the harness never sees
		const assistantId = '@twake-space-assistant-bob:test.local';
		const appservice: MatrixUser = {
			userId: '@twake-space-assistant:test.local',
			accessToken: h.config.matrix.asToken
		};
		const registered = await h.synapse.request(appservice, 'POST', '/_matrix/client/v3/register', {
			type: 'm.login.application_service',
			username: 'twake-space-assistant-bob',
			inhibit_login: true
		});
		expect(registered.status).toBe(200);
		const foreignMaster = makeEd25519Key();
		const foreignSelfSigning = makeEd25519Key();
		const selfSigningKey = {
			user_id: assistantId,
			usage: ['self_signing'],
			keys: { [`ed25519:${foreignSelfSigning.publicKey}`]: foreignSelfSigning.publicKey }
		};
		const uploaded = await h.synapse.request(
			appservice,
			'POST',
			`/_matrix/client/v3/keys/device_signing/upload?user_id=${encodeURIComponent(assistantId)}`,
			{
				master_key: {
					user_id: assistantId,
					usage: ['master'],
					keys: { [`ed25519:${foreignMaster.publicKey}`]: foreignMaster.publicKey }
				},
				self_signing_key: {
					...selfSigningKey,
					signatures: {
						[assistantId]: {
							[`ed25519:${foreignMaster.publicKey}`]: foreignMaster.sign(selfSigningKey)
						}
					}
				}
			}
		);
		expect(uploaded.status).toBe(200);

		const { owner } = await createAssistant('bob', 'Friday');
		const keys = await keysOf(owner, assistantId);
		const master = Object.values(keys.master_keys?.[assistantId]?.keys ?? {});
		expect(master).toHaveLength(1);
		expect(master).not.toContain(foreignMaster.publicKey);
		expect(devicesSignedBySelfSigningKey(keys, assistantId)).toBe(true);
		expect(resetsOf('bob@test.local').map((l) => l['replaced'])).toEqual([true]);
	}, 120_000);
});
