import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withPrincipal } from '../src/db/client.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

const OWNER = 'alice@test.local';
const ASSISTANT_ID = '@twake-space-assistant-alice:test.local';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Alice, her verified session, and her conversation with the creator, encrypted as Twake Chat opens
// its direct messages
interface CreatorRoom {
	readonly h: MatrixTestHarness;
	readonly alice: MatrixUser;
	readonly client: E2eeClient;
	readonly room: string;
	readonly creatorId: string;
	// What the creator said in the room that starts with a prefix, as Alice's session read it
	saying(prefix: string): string[];
	nextSaying(prefix: string, seen: number): Promise<string>;
	close(): Promise<void>;
}

async function startCreatorRoom(env: Record<string, string>): Promise<CreatorRoom> {
	const h = await startMatrixHarness({ env });
	const alice = await h.synapse.registerUser('alice');
	const client = await startE2eeClient(h.synapse.url, alice);
	const creatorId = h.role.creatorUserId;
	const room = await client.createDirectRoom(creatorId);
	await client.waitForMessage(room, creatorId, (t) => t.includes('/newbot'));
	const saying = (prefix: string): string[] =>
		client.messages
			.filter((m) => m.roomId === room && m.sender === creatorId && m.body.startsWith(prefix))
			.map((m) => m.body);
	return {
		h,
		alice,
		client,
		room,
		creatorId,
		saying,
		nextSaying: async (prefix, seen) => {
			for (let i = 0; i < 120; i += 1) {
				const latest = saying(prefix).at(seen);
				if (latest !== undefined) return latest;
				await sleep(250);
			}
			throw new Error(`the creator said nothing new starting with ${prefix}`);
		},
		close: async () => {
			await client.stop();
			await h.close();
		}
	};
}

// Another session of Alice's, opened anew in a browser and never verified
async function unverifiedSession(r: CreatorRoom, sessions: E2eeClient[]): Promise<E2eeClient> {
	const session = await startE2eeClient(r.h.synapse.url, await r.h.synapse.login('alice'), {
		session: 'unsigned'
	});
	sessions.push(session);
	return session;
}

async function logged(
	r: CreatorRoom,
	msg: string,
	eventId: string
): Promise<Record<string, unknown>> {
	for (let i = 0; i < 120; i += 1) {
		const line = r.h.logLines().find((l) => l['eventId'] === eventId && l['msg'] === msg);
		if (line !== undefined) return line;
		await sleep(250);
	}
	throw new Error(`nothing logged as ${msg} for ${eventId}`);
}

const IDENTITY_ROUTE = '/v1/assistants/me/owner-identity';

// One of the harness's tables is out of reach while `run` runs, as with a database failing on it
async function withoutTable(
	r: CreatorRoom,
	table: string,
	run: () => Promise<void>
): Promise<void> {
	await r.h.db.sql.unsafe(`alter table ${table} rename to ${table}_away`);
	try {
		await run();
	} finally {
		await r.h.db.sql.unsafe(`alter table ${table}_away rename to ${table}`);
	}
}

async function assistantName(r: CreatorRoom): Promise<string | null> {
	const reply = await r.h.api.get<{ name?: string }>(OWNER, '/v1/assistants/me');
	return reply.status === 200 ? (reply.body.name ?? null) : null;
}

const UNVERIFIED_MESSAGE =
	'I did not act on your last message: it came from a session of yours that I cannot verify. In another of your Twake Chat sessions, open Settings > Devices, find this one marked Unverified and tap Verify; then send it again.';
const UNENCRYPTED_MESSAGE =
	'I did not act on your last message: it reached me unencrypted, and I act only on what your verified sessions encrypt.';
const UNVERIFIED_REPORT =
	'This session of yours is not verified. I act on what you write from it for now; verify it so that I keep doing so: in another of your Twake Chat sessions, open Settings > Devices, find this one marked Unverified and tap Verify.';

describe('the creator takes my commands only from the sessions my identity signed', () => {
	let r: CreatorRoom;
	const sessions: E2eeClient[] = [];
	beforeAll(async () => {
		r = await startCreatorRoom({ OWNER_DEVICE_TRUST: 'enforce' });
	}, 240_000);
	afterAll(async () => {
		for (const session of sessions) await session.stop();
		if (r !== undefined) await r.close();
	});

	it('creates my assistant from what my verified session writes', async () => {
		const asked = r.saying('Which name').length;
		await r.client.sendText(r.room, '/newbot');
		expect(await r.nextSaying('Which name', asked)).toBe(
			'Which name do you want for your assistant?'
		);
		const done = r.saying('Done.').length;
		await r.client.sendText(r.room, 'Jarvis');
		expect(await r.nextSaying('Done.', done)).toContain(ASSISTANT_ID);
		expect((await r.h.api.get(OWNER, '/v1/assistants/me')).status).toBe(200);
	});

	it('takes no command from a session I never verified, and tells me why', async () => {
		const other = await unverifiedSession(r, sessions);
		const notices = r.saying('I did not act on your last message').length;
		const eventId = await other.sendText(r.room, '/delete');
		expect(await r.h.decisionOn(eventId)).toMatchObject({
			msg: 'assistant ignored an unverified device',
			deviceId: other.deviceId,
			signed: false,
			mode: 'enforce'
		});
		expect(await r.nextSaying('I did not act on your last message', notices)).toBe(
			UNVERIFIED_MESSAGE
		);
		// My assistant is still there
		expect((await r.h.api.get(OWNER, '/v1/assistants/me')).status).toBe(200);
		expect(
			r.h.logLines().some((l) => l['msg'] === 'creator command' && l['command'] === '/delete')
		).toBe(false);
	});

	it('takes no command written in clear in my name, and tells me why', async () => {
		const notices = r.saying('I did not act on your last message: it reached me').length;
		const eventId = await r.h.synapse.sendText(r.alice, r.room, '/delete');
		expect(await r.h.decisionOn(eventId)).toMatchObject({
			msg: 'assistant ignored an unencrypted message',
			reason: 'unencrypted',
			mode: 'enforce'
		});
		expect(await r.nextSaying('I did not act on your last message: it reached me', notices)).toBe(
			UNENCRYPTED_MESSAGE
		);
		expect((await r.h.api.get(OWNER, '/v1/assistants/me')).status).toBe(200);
	});

	it('renames my assistant only from my verified session', async () => {
		const other = await unverifiedSession(r, sessions);
		const eventId = await other.sendText(r.room, '/rename Alfred');
		expect((await r.h.decisionOn(eventId))?.['msg']).toBe('assistant ignored an unverified device');
		expect(await assistantName(r)).toBe('Jarvis');
		const renamed = r.saying('Your assistant is now called').length;
		await r.client.sendText(r.room, '/rename Jeeves');
		expect(await r.nextSaying('Your assistant is now called', renamed)).toBe(
			'Your assistant is now called Jeeves.'
		);
		expect(await assistantName(r)).toBe('Jeeves');
	});

	it('takes the name it asked me for only from my verified session', async () => {
		const deleted = r.saying('Your assistant is deleted').length;
		await r.client.sendText(r.room, '/delete');
		await r.nextSaying('Your assistant is deleted', deleted);
		const asked = r.saying('Which name').length;
		await r.client.sendText(r.room, '/newbot');
		await r.nextSaying('Which name', asked);
		// A name from a session I never verified is no answer to the question
		const other = await unverifiedSession(r, sessions);
		const fromOther = await other.sendText(r.room, 'Alfred');
		expect((await r.h.decisionOn(fromOther))?.['msg']).toBe(
			'assistant ignored an unverified device'
		);
		expect(await assistantName(r)).toBeNull();
		// The one my verified session gives is
		const done = r.saying('Done.').length;
		await r.client.sendText(r.room, 'Iris');
		expect(await r.nextSaying('Done.', done)).toContain('Iris');
		expect(await assistantName(r)).toBe('Iris');
	});

	it('takes no command when it cannot check my session, and tells me to try again', async () => {
		const notices = r.saying('Something went wrong on my side').length;
		await withoutTable(r, 'owner_cross_signing', async () => {
			const eventId = await r.client.sendText(r.room, '/delete');
			expect(await logged(r, 'owner device check failed', eventId)).toMatchObject({
				mode: 'enforce'
			});
			expect(await r.nextSaying('Something went wrong on my side', notices)).toBe(
				'Something went wrong on my side. Please try again in a moment.'
			);
		});
		expect(await assistantName(r)).toBe('Iris');
	});

	it('lets me accept a new identity through the API before I have an assistant', async () => {
		const bob = await r.h.synapse.registerUser('bob');
		const client = await startE2eeClient(r.h.synapse.url, bob);
		sessions.push(client);
		const room = await client.createDirectRoom(r.creatorId);
		await client.waitForMessage(room, r.creatorId, (t) => t.includes('/newbot'));
		await client.sendText(room, '/help');
		await client.waitForMessage(room, r.creatorId, (t) => t.startsWith('I create and manage'));
		const before = await client.masterKey();
		const after = await client.resetIdentity();
		const eventId = await client.sendText(room, '/newbot');
		expect(await r.h.decisionOn(eventId)).toMatchObject({
			msg: 'assistant ignored an unverified device',
			identity: 'changed'
		});
		const view = await r.h.api.get('bob@test.local', IDENTITY_ROUTE);
		expect(view.status).toBe(200);
		expect(view.body).toMatchObject({
			pinned: { master_key: before },
			published: { master_key: after }
		});
		const accepted = await r.h.api.put('bob@test.local', IDENTITY_ROUTE, { master_key: after });
		expect(accepted.status).toBe(200);
		await client.sendText(room, '/newbot');
		expect(await client.waitForMessage(room, r.creatorId, (t) => t.startsWith('Which name'))).toBe(
			'Which name do you want for your assistant?'
		);
		const held = await withPrincipal(
			r.h.db,
			{ id: 'bob@test.local' },
			(tx) =>
				tx.sql<{ pinned_by: string }[]>`
					select pinned_by from owner_cross_signing where owner = 'bob@test.local'`
		);
		expect(held.map((row) => row.pinned_by)).toEqual(['api']);
	});
});

describe('while the harness only reports the sessions the creator would not take commands from', () => {
	let r: CreatorRoom;
	const sessions: E2eeClient[] = [];
	beforeAll(async () => {
		// What a deployment that sets nothing does
		r = await startCreatorRoom({});
	}, 240_000);
	afterAll(async () => {
		for (const session of sessions) await session.stop();
		if (r !== undefined) await r.close();
	});

	it('takes a command from a session I never verified all the same, logs it, and tells me once', async () => {
		const other = await unverifiedSession(r, sessions);
		const helped = r.saying('I create and manage').length;
		const eventId = await other.sendText(r.room, '/help');
		expect(await r.nextSaying('I create and manage', helped)).toContain('/newbot');
		expect(await logged(r, 'owner device unverified', eventId)).toMatchObject({
			mode: 'report',
			deviceId: other.deviceId,
			signed: false
		});
		expect(await r.nextSaying('This session of yours is not verified', 0)).toBe(UNVERIFIED_REPORT);
		// Once per session
		const again = r.saying('I create and manage').length;
		await other.sendText(r.room, '/help');
		expect(await r.nextSaying('I create and manage', again)).toContain('/newbot');
		expect(r.saying('This session of yours is not verified')).toHaveLength(1);
	});

	it('takes a command written in clear in my name all the same, and logs it', async () => {
		const helped = r.saying('I create and manage').length;
		const eventId = await r.h.synapse.sendText(r.alice, r.room, '/help');
		expect(await r.nextSaying('I create and manage', helped)).toContain('/newbot');
		expect(await logged(r, 'owner message unencrypted', eventId)).toMatchObject({
			mode: 'report',
			reason: 'unencrypted'
		});
	});
});
