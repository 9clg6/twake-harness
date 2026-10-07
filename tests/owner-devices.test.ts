import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { withPrincipal } from '../src/db/client.js';
import {
	modelFor,
	readCatalog,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';

const OWNER = 'alice@test.local';
const IDENTITY_ROUTE = '/v1/assistants/me/owner-identity';

// What the matrix role logs of the session the owner's words came from
const DEVICE_LINES = new Set([
	'owner device verified',
	'owner device unverified',
	'assistant ignored an unverified device'
]);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deviceLine(r: ConsentRoom, eventId: string): Promise<Record<string, unknown>> {
	for (let i = 0; i < 120; i += 1) {
		const line = r.h
			.logLines()
			.find((l) => l['eventId'] === eventId && DEVICE_LINES.has(String(l['msg'])));
		if (line !== undefined) return line;
		await sleep(250);
	}
	throw new Error(`nothing logged of the session ${eventId} came from`);
}

// The line the matrix role logged with a message, once it did
async function logged(
	r: ConsentRoom,
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

// One of the harness's tables is out of reach while `run` runs, as with a database failing on it
async function withoutTable(
	r: ConsentRoom,
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

async function until(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 120; i += 1) {
		if (check()) return;
		await sleep(250);
	}
	throw new Error(`${what} never happened`);
}

// An event of Alice's room as the homeserver holds it, encrypted
async function encryptedEvent(r: ConsentRoom, eventId: string): Promise<Record<string, unknown>> {
	const reply = await r.h.synapse.request(
		r.alice,
		'GET',
		`/_matrix/client/v3/rooms/${encodeURIComponent(r.room)}/event/${encodeURIComponent(eventId)}`
	);
	return reply.body;
}

// Pushes events to the matrix role as the homeserver does, in a transaction of their own
async function push(r: ConsentRoom, events: Record<string, unknown>[]): Promise<number> {
	const reply = await fetch(
		`http://127.0.0.1:${r.h.port}/_matrix/app/v1/transactions/test-${Date.now()}-${Math.random()}`,
		{
			method: 'PUT',
			headers: { authorization: `Bearer ${r.h.hsToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ events })
		}
	);
	return reply.status;
}

// The identity the harness holds for Alice, as it keeps it
async function heldIdentity(
	r: ConsentRoom
): Promise<{ master_public_key: string; pinned_by: string } | null> {
	const rows = await withPrincipal(
		r.h.db,
		{ id: OWNER },
		(tx) =>
			tx.sql<{ master_public_key: string; pinned_by: string }[]>`
				select master_public_key, pinned_by from owner_cross_signing where owner = ${OWNER}`
	);
	return rows[0] ?? null;
}

// Another session of Alice's, opened anew in a browser and never verified
async function unverifiedSession(r: ConsentRoom, sessions: E2eeClient[]): Promise<E2eeClient> {
	const session = await startE2eeClient(r.h.synapse.url, await r.h.synapse.login('alice'), {
		session: 'unsigned'
	});
	sessions.push(session);
	return session;
}

const UNVERIFIED_MESSAGE =
	'I did not act on your last message: it came from a session of yours that I cannot verify. In another of your Twake Chat sessions, open Settings > Devices, find this one marked Unverified and tap Verify; then send it again.';
const UNVERIFIED_ANSWER =
	'I did not take your answer, so my question still waits: it came from a session of yours that I cannot verify. In another of your Twake Chat sessions, open Settings > Devices, find this one marked Unverified and tap Verify; then answer again.';
const CHANGED_MESSAGE =
	"I did not act on your last message: your encryption identity is not the one I know. If you reset it yourself, confirm the new one through your assistant's API (PUT /v1/assistants/me/owner-identity); until then I act on none of your messages.";
const UNVERIFIED_REPORT =
	'This session of yours is not verified. I act on what you write from it for now; verify it so that I keep doing so: in another of your Twake Chat sessions, open Settings > Devices, find this one marked Unverified and tap Verify.';
const CHANGED_REPORT =
	"Your encryption identity is not the one I know. I act on what you write for now; if you reset it yourself, confirm the new one through your assistant's API (PUT /v1/assistants/me/owner-identity) so that I keep doing so.";

describe('the setting of how my sessions are held to my identity', () => {
	const base = {
		HARNESS_ROLE: 'api',
		DATABASE_URL: 'postgres://x@localhost/x',
		AUTH_JWKS_URL: 'https://example.test/jwks',
		AUTH_ISSUER: 'https://example.test/',
		AUTH_AUDIENCE: 'twake-harness',
		APISIX_BASE_URL: 'http://apisix.test',
		APISIX_CONSUMER_KEY: 'k'
	};

	it('only reports unless a deployment enforces it, and refuses anything else at startup', () => {
		expect(loadConfig(base).matrix.ownerDeviceTrust).toBe('report');
		expect(loadConfig({ ...base, OWNER_DEVICE_TRUST: 'enforce' }).matrix.ownerDeviceTrust).toBe(
			'enforce'
		);
		expect(() => loadConfig({ ...base, OWNER_DEVICE_TRUST: 'strict' })).toThrow(
			'invalid configuration: OWNER_DEVICE_TRUST'
		);
	});
});

describe('my assistant acts only on what the sessions my identity signed write', () => {
	let r: ConsentRoom;
	const sessions: E2eeClient[] = [];
	beforeAll(async () => {
		r = await startConsentRoom({ OWNER_DEVICE_TRUST: 'enforce', ADMISSION_USER_PER_MINUTE: '100' });
		r.h.apisix.contracts.spec = readCatalog(['mail']);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(1);
		r.h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
		r.h.apisix.llm.script = modelFor({
			'Find the budget in my mail': { tool: 'search_mail', args: { q: 'budget' } }
		});
	}, 240_000);
	afterAll(async () => {
		for (const session of sessions) await session.stop();
		if (r !== undefined) await r.close();
	});

	it('acts on what my verified session writes, and holds the identity it first saw', async () => {
		const heard = r.saying('Heard:').length;
		const eventId = await r.client.sendText(r.room, 'Good morning');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Good morning');
		expect(await deviceLine(r, eventId)).toMatchObject({
			msg: 'owner device verified',
			mode: 'enforce',
			via: 'message',
			deviceId: r.client.deviceId,
			signed: true,
			identity: 'first_seen',
			matchesPin: true
		});
		const masterKey = await r.client.masterKey();
		expect(masterKey).not.toBeNull();
		expect(await heldIdentity(r)).toEqual({ master_public_key: masterKey, pinned_by: 'first_use' });
		// What I read of it through the API, with my own token
		const view = await r.h.api.get(OWNER, IDENTITY_ROUTE);
		expect(view.status).toBe(200);
		expect(view.body).toMatchObject({
			pinned: { master_key: masterKey, pinned_by: 'first_use' },
			published: null
		});
		// Someone without an assistant has nothing there
		expect((await r.h.api.get('bob@test.local', IDENTITY_ROUTE)).status).toBe(404);
	});

	it('does not act on a session I never verified, and tells me why and how to verify it', async () => {
		const other = await unverifiedSession(r, sessions);
		const notices = r.saying('I did not act on your last message').length;
		const eventId = await other.sendText(r.room, 'Find the budget in my mail');
		const decision = await r.h.decisionOn(eventId);
		expect(decision).toMatchObject({
			msg: 'assistant ignored an unverified device',
			mode: 'enforce',
			via: 'message',
			deviceId: other.deviceId,
			signed: false,
			identity: 'pinned',
			matchesPin: true
		});
		// The log names the session, never what it wrote
		expect(JSON.stringify(decision)).not.toContain('budget');
		expect(await r.nextSaying('I did not act on your last message', notices)).toBe(
			UNVERIFIED_MESSAGE
		);
		// No turn: the model never read it, and nothing was asked
		const told = r.h.apisix.llm.calls.flatMap((c) => c.request.messages);
		expect(told.some((m) => m.role === 'user' && (m.content ?? '').includes('budget'))).toBe(false);
		expect(r.questions()).toHaveLength(0);
		// Its next message right after is not acted on either, and tells me nothing new within the
		// minute
		const again = await other.sendText(r.room, 'Hello?');
		expect((await r.h.decisionOn(again))?.['msg']).toBe('assistant ignored an unverified device');
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Still there?');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Still there?');
		expect(r.saying('I did not act on your last message')).toHaveLength(notices + 1);
	});

	it('keeps a question waiting when a session I never verified answers it', async () => {
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Find the budget in my mail');
		const question = await r.nextQuestion(seen);
		// A yes in words from a session I never verified: not taken
		const other = await unverifiedSession(r, sessions);
		let notices = r.saying('I did not act on your last message').length;
		const yes = await other.sendText(r.room, 'yes');
		expect(await r.h.decisionOn(yes)).toMatchObject({
			msg: 'assistant ignored an unverified device',
			deviceId: other.deviceId
		});
		expect(await r.nextSaying('I did not act on your last message', notices)).toBe(
			UNVERIFIED_MESSAGE
		);
		// A tap on the question from another one: not taken either
		const third = await unverifiedSession(r, sessions);
		notices = r.saying('I did not take your answer').length;
		const tap = await third.react(r.room, question, '✅');
		expect(await deviceLine(r, tap)).toMatchObject({
			msg: 'assistant ignored an unverified device',
			via: 'answer',
			deviceId: third.deviceId,
			signed: false
		});
		expect(await r.nextSaying('I did not take your answer', notices)).toBe(UNVERIFIED_ANSWER);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
		expect((await r.callsTo('mail')).map((c) => c.status)).toEqual(['open']);
		// My verified session's yes, still my next message after the question, runs the call
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'yes');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/mail/items');
		expect((await r.callsTo('mail')).map((c) => c.status)).toEqual(['approved']);
	});

	it('acts on nothing from a session I never verified when it cannot tell me so either', async () => {
		const other = await unverifiedSession(r, sessions);
		await withoutTable(r, 'owner_device_notices', async () => {
			const eventId = await other.sendText(r.room, 'Archive my old mail');
			expect(await r.h.decisionOn(eventId)).toMatchObject({
				msg: 'assistant ignored an unverified device',
				deviceId: other.deviceId
			});
			expect(await logged(r, 'owner device notice failed', eventId)).toMatchObject({
				reason: 'unverified'
			});
		});
		const told = r.h.apisix.llm.calls.flatMap((c) => c.request.messages);
		expect(told.some((m) => m.role === 'user' && (m.content ?? '').includes('Archive'))).toBe(
			false
		);
	});

	it('acts only on the words of the very event whose session it checked', async () => {
		// A session I never verified writes one thing, and my verified session another
		const other = await unverifiedSession(r, sessions);
		const fromOther = await other.sendText(r.room, 'Plan my week');
		expect((await r.h.decisionOn(fromOther))?.['msg']).toBe(
			'assistant ignored an unverified device'
		);
		const heard = r.saying('Heard:').length;
		const fromMine = await r.client.sendText(r.room, 'Good night');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Good night');
		// The room settles: the answer is marked done
		expect(await r.client.waitForReactions(r.room, fromMine, r.assistantId, 2)).toContain('✅');
		await sleep(1000);
		const otherEvent = await encryptedEvent(r, fromOther);
		const myEvent = await encryptedEvent(r, fromMine);
		const answered = r.saying('Heard:').length;
		// Both arrive again under one new id: the words acted on are those of the decryption that was
		// checked
		const releases: (() => void)[] = [];
		const membersOfRoom = `/_matrix/client/v3/rooms/${encodeURIComponent(r.room)}/joined_members`;
		r.h.apisix.matrixHold = (call) => {
			const target = new URL(call.path, 'http://synapse');
			const asUser = target.searchParams.get('user_id') ?? r.h.role.creatorUserId;
			if (
				releases.length >= 2 ||
				target.pathname !== membersOfRoom ||
				asUser !== r.h.role.creatorUserId
			) {
				return null;
			}
			return new Promise<void>((resolve) => releases.push(resolve));
		};
		const id = `$same-${Date.now()}`;
		try {
			const first = push(r, [{ ...otherEvent, event_id: id }]);
			await until(() => releases.length === 1, 'the first push held up');
			const second = push(r, [{ ...myEvent, event_id: id }]);
			await until(() => releases.length === 2, 'the second push held up');
			releases[0]?.();
			expect(await first).toBe(200);
			releases[1]?.();
			expect(await second).toBe(200);
		} finally {
			r.h.apisix.matrixHold = null;
			for (const release of releases) release();
		}
		// The turn taken under that id carries the words of the session checked
		expect((await r.h.decisionOn(id))?.['msg']).toBe('turn queued');
		expect(await r.nextSaying('Heard:', answered)).toBe('Heard: Good night');
		// Nothing of what the unverified session wrote ever reached the model
		const told = r.h.apisix.llm.calls.flatMap((c) => c.request.messages);
		expect(told.some((m) => m.role === 'user' && (m.content ?? '').includes('Plan my week'))).toBe(
			false
		);
	});

	it('acts on none of my words once my identity changed, until I accept it through the API', async () => {
		const before = await r.client.masterKey();
		const after = await r.client.resetIdentity();
		expect(after).not.toBe(before);
		const notices = r.saying('I did not act on your last message').length;
		const eventId = await r.client.sendText(r.room, 'Good evening');
		expect(await r.h.decisionOn(eventId)).toMatchObject({
			msg: 'assistant ignored an unverified device',
			deviceId: r.client.deviceId,
			signed: true,
			identity: 'changed',
			matchesPin: false
		});
		expect(await r.nextSaying('I did not act on your last message', notices)).toBe(CHANGED_MESSAGE);
		expect(await heldIdentity(r)).toEqual({ master_public_key: before, pinned_by: 'first_use' });
		// Through the API, with my own token, I see both, and accept only the one my words came with
		const view = await r.h.api.get(OWNER, IDENTITY_ROUTE);
		expect(view.body).toMatchObject({
			pinned: { master_key: before, pinned_by: 'first_use' },
			published: { master_key: after }
		});
		const stale = await r.h.api.put(OWNER, IDENTITY_ROUTE, { master_key: before });
		expect(stale.status).toBe(409);
		expect((await r.h.api.put(OWNER, IDENTITY_ROUTE, {})).status).toBe(400);
		const accepted = await r.h.api.put(OWNER, IDENTITY_ROUTE, { master_key: after });
		expect(accepted.status).toBe(200);
		expect(accepted.body).toMatchObject({
			pinned: { master_key: after, pinned_by: 'api' },
			published: null
		});
		// My words count again
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Good evening again');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Good evening again');
	});

	it('offers me to accept only an identity that signed the session my words came from', async () => {
		const held = await r.client.masterKey();
		// Another session of mine, signed as Twake Chat signs it, replaces my identity with a new one
		// that signs it alone
		const other = await startE2eeClient(r.h.synapse.url, await r.h.synapse.login('alice'));
		sessions.push(other);
		const replaced = await other.resetIdentity();
		expect(replaced).not.toBe(held);
		// Words from my first session, which the new identity did not sign, offer nothing to accept
		const first = await r.client.sendText(r.room, 'From my first session');
		expect(await r.h.decisionOn(first)).toMatchObject({
			msg: 'assistant ignored an unverified device',
			deviceId: r.client.deviceId,
			signed: false,
			identity: 'changed'
		});
		expect((await r.h.api.get(OWNER, IDENTITY_ROUTE)).body).toMatchObject({
			pinned: { master_key: held },
			published: null
		});
		expect((await r.h.api.put(OWNER, IDENTITY_ROUTE, { master_key: replaced })).status).toBe(409);
		// Words from the session the new identity signed offer it
		const second = await other.sendText(r.room, 'From my other session');
		expect(await r.h.decisionOn(second)).toMatchObject({
			msg: 'assistant ignored an unverified device',
			deviceId: other.deviceId,
			signed: true,
			identity: 'changed'
		});
		expect((await r.h.api.get(OWNER, IDENTITY_ROUTE)).body).toMatchObject({
			pinned: { master_key: held },
			published: { master_key: replaced }
		});
		expect((await r.h.api.put(OWNER, IDENTITY_ROUTE, { master_key: replaced })).status).toBe(200);
		const heard = r.saying('Heard:').length;
		await other.sendText(r.room, 'Accepted at last');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Accepted at last');
	});
});

describe('while the harness only reports the sessions it would not act on', () => {
	let r: ConsentRoom;
	const sessions: E2eeClient[] = [];
	beforeAll(async () => {
		// What a deployment that sets nothing does
		r = await startConsentRoom({ ADMISSION_USER_PER_MINUTE: '100' });
		r.h.apisix.llm.script = modelFor({});
	}, 240_000);
	afterAll(async () => {
		for (const session of sessions) await session.stop();
		if (r !== undefined) await r.close();
	});

	it('acts on a session I never verified all the same, logs it, and tells me once how to verify it', async () => {
		const other = await unverifiedSession(r, sessions);
		const heard = r.saying('Heard:').length;
		const eventId = await other.sendText(r.room, 'Hello from my other browser');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Hello from my other browser');
		const line = await deviceLine(r, eventId);
		expect(line).toMatchObject({
			msg: 'owner device unverified',
			mode: 'report',
			via: 'message',
			deviceId: other.deviceId,
			signed: false,
			identity: 'first_seen',
			matchesPin: true
		});
		expect(JSON.stringify(line)).not.toContain('other browser');
		expect(await r.nextSaying('This session of yours is not verified', 0)).toBe(UNVERIFIED_REPORT);
		// The identity is held all the same
		expect(await heldIdentity(r)).toEqual({
			master_public_key: await r.client.masterKey(),
			pinned_by: 'first_use'
		});
		// Once per session: its next message is acted on without a second notice
		const again = r.saying('Heard:').length;
		await other.sendText(r.room, 'And again');
		expect(await r.nextSaying('Heard:', again)).toBe('Heard: And again');
		// My verified session is acted on, and logged, without a word about it
		const verified = r.saying('Heard:').length;
		const mine = await r.client.sendText(r.room, 'From my phone');
		expect(await r.nextSaying('Heard:', verified)).toBe('Heard: From my phone');
		expect(await deviceLine(r, mine)).toMatchObject({
			msg: 'owner device verified',
			mode: 'report',
			deviceId: r.client.deviceId,
			signed: true,
			matchesPin: true
		});
		expect(r.saying('This session of yours is not verified')).toHaveLength(1);
	});

	it('acts on my words all the same when it cannot tell me about my session', async () => {
		const other = await unverifiedSession(r, sessions);
		await withoutTable(r, 'owner_device_notices', async () => {
			const heard = r.saying('Heard:').length;
			const eventId = await other.sendText(r.room, 'Despite everything');
			expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Despite everything');
			expect(await logged(r, 'owner device notice failed', eventId)).toMatchObject({
				reason: 'unverified'
			});
		});
	});

	it('acts on my words after my identity changed all the same, and tells me how to accept it', async () => {
		const before = await r.client.masterKey();
		const after = await r.client.resetIdentity();
		expect(after).not.toBe(before);
		const heard = r.saying('Heard:').length;
		const eventId = await r.client.sendText(r.room, 'After my reset');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: After my reset');
		expect(await deviceLine(r, eventId)).toMatchObject({
			msg: 'owner device unverified',
			mode: 'report',
			signed: true,
			identity: 'changed',
			matchesPin: false
		});
		expect(await r.nextSaying('Your encryption identity is not the one I know', 0)).toBe(
			CHANGED_REPORT
		);
		const view = await r.h.api.get(OWNER, IDENTITY_ROUTE);
		expect(view.body).toMatchObject({
			pinned: { master_key: before },
			published: { master_key: after }
		});
	});
});
