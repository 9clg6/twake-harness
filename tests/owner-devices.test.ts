import { OlmMachine } from '@matrix-org/matrix-sdk-crypto-nodejs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { withPrincipal } from '../src/db/client.js';
import {
	modelFor,
	QUESTION_CONTENT_KEY,
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

// An event of Alice's room as the homeserver would push it, carrying what one of her sessions
// encrypted
function sealedEvent(
	r: ConsentRoom,
	eventId: string,
	content: Record<string, unknown>
): Record<string, unknown> {
	return {
		type: 'm.room.encrypted',
		room_id: r.room,
		sender: r.alice.userId,
		event_id: eventId,
		origin_server_ts: Date.now(),
		content,
		unsigned: {}
	};
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

// A room of Alice's assistant that reads as clear: opened without encryption, and held as one of
// the assistant's rooms
async function clearRoom(r: ConsentRoom): Promise<string> {
	const room = await r.h.synapse.createDirectRoom(r.alice, r.assistantId);
	for (let i = 0; i < 120; i += 1) {
		if ((await r.h.synapse.joinedMembers(r.alice, room)).includes(r.assistantId)) break;
		await sleep(250);
	}
	// The harness records a room its owner invited the assistant to by itself, and may have already
	await r.h.db.sql`
		insert into assistant_rooms (room_id, owner, user_id) values (${room}, ${OWNER}, ${r.assistantId})
		on conflict (room_id) do nothing`;
	return room;
}

// The SDK's look-up of who can decrypt an event of Alice's room fails at the homeserver while
// `run` runs: the assistant then reads the event again, once it fetched its device's inbox, which
// holds a message for it so that there is something to fetch
async function readAgain(r: ConsentRoom, run: () => Promise<void>): Promise<void> {
	const sent = await r.h.synapse.request(
		r.alice,
		'PUT',
		`/_matrix/client/v3/sendToDevice/m.dummy/test-${Date.now()}`,
		{ messages: { [r.assistantId]: { '*': {} } } }
	);
	expect(sent.status).toBe(200);
	const membersOfRoom = `/_matrix/client/v3/rooms/${encodeURIComponent(r.room)}/joined_members`;
	r.h.apisix.matrixFault = (call) => {
		const target = new URL(call.path, 'http://synapse');
		const asUser = target.searchParams.get('user_id') ?? r.h.role.creatorUserId;
		return target.pathname === membersOfRoom && asUser === r.h.role.creatorUserId ? 500 : null;
	};
	try {
		await run();
	} finally {
		r.h.apisix.matrixFault = null;
	}
}

// The assistant's engine decrypts an event once, and fails to decrypt it again while `run` runs:
// the check, which decrypts it after the SDK did, then fails at its decryption
async function decryptedOnce(eventId: string, run: () => Promise<void>): Promise<void> {
	const decrypt = Reflect.get(
		OlmMachine.prototype,
		'decryptRoomEvent'
	) as OlmMachine['decryptRoomEvent'];
	let decrypted = false;
	OlmMachine.prototype.decryptRoomEvent = async function (
		this: OlmMachine,
		...args: Parameters<OlmMachine['decryptRoomEvent']>
	) {
		const event = JSON.parse(args[0]) as { event_id?: unknown };
		if (event.event_id === eventId && decrypted)
			throw new Error('the event is not decrypted again');
		const result = await decrypt.apply(this, args);
		if (event.event_id === eventId) decrypted = true;
		return result;
	};
	try {
		await run();
	} finally {
		OlmMachine.prototype.decryptRoomEvent = decrypt;
	}
}

// When the harness first took words of one of Alice's Megolm sessions for new, null if it never did
async function firstSeen(r: ConsentRoom, sessionId: string): Promise<Date | null> {
	const rows = await withPrincipal(
		r.h.db,
		{ id: OWNER },
		(tx) => tx.sql<{ first_seen_at: Date }[]>`
			select first_seen_at from owner_megolm_sessions
			where owner = ${OWNER} and session_id = ${sessionId}`
	);
	return rows[0]?.first_seen_at ?? null;
}

// Alice's Megolm sessions as the harness sees them a month after it first decrypted words of them,
// while `run` runs
async function sessionsAMonthOld(r: ConsentRoom, run: () => Promise<void>): Promise<void> {
	await withPrincipal(
		r.h.db,
		{ id: OWNER },
		(tx) => tx.sql`
			update owner_megolm_sessions set first_seen_at = now() - interval '31 days'
			where owner = ${OWNER}`
	);
	try {
		await run();
	} finally {
		await withPrincipal(
			r.h.db,
			{ id: OWNER },
			(tx) => tx.sql`update owner_megolm_sessions set first_seen_at = now() where owner = ${OWNER}`
		);
	}
}

// Alice was last told about her sessions over a minute ago, as the harness counts it
async function lastToldAMinuteAgo(r: ConsentRoom): Promise<void> {
	await withPrincipal(
		r.h.db,
		{ id: OWNER },
		(tx) => tx.sql`
			update owner_device_notices set notified_at = now() - interval '61 seconds'
			where owner = ${OWNER}`
	);
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
	"I did not act on your last message: your encryption identity changed, and I act only on the one I know. If you reset it yourself, confirm the new one through your assistant's API (PUT /v1/assistants/me/owner-identity): for your safety, no message can do it. If you did not, change your password and warn your administrator. Until then I act on none of your messages.";
const UNENCRYPTED_MESSAGE =
	'I did not act on your last message: it reached me unencrypted, and I act only on what your verified sessions encrypt.';
const NO_IDENTITY_MESSAGE =
	'I did not act on your last message: your account has no encryption identity yet, so I cannot verify any of your sessions. Sign out of Twake Chat and sign in again to set it up; then send it again.';
const OLD_SESSION_MESSAGE =
	'I did not act on your last message: your app encrypted it with keys it has used for more than thirty days, which I no longer accept. Send /discardsession in this room so that it uses new ones; then send it again.';
const UNVERIFIED_REPORT =
	'This session of yours is not verified. I act on what you write from it for now; verify it so that I keep doing so: in another of your Twake Chat sessions, open Settings > Devices, find this one marked Unverified and tap Verify.';
const CHANGED_QUESTION =
	'Your encryption identity is not the one I know. Did you reset your identity yourself? Answer yes or no in your next message.';
const UNSIGNED_REPORT =
	'Your encryption identity changed, and the new one did not sign this session. I act on what you write for now; so that I can ask you whether you reset it yourself, write to me from a session it signed, or verify this one: in another of your Twake Chat sessions, open Settings > Devices, find this one marked Unverified and tap Verify.';

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
		r.h.apisix.contracts.spec = readCatalog(['mail', 'drive', 'notes', 'tasks']);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(4);
		r.h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
		r.h.apisix.llm.script = modelFor({
			'Find the budget in my mail': { tool: 'search_mail', args: { q: 'budget' } },
			'Find the plan in my drive': { tool: 'search_drive', args: { q: 'plan' } },
			'Search my notes': { tool: 'search_notes', args: { q: 'notes' } },
			'List my tasks': { tool: 'search_tasks', args: { q: 'tasks' } }
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
		// Someone the harness never took words from has no identity held
		const nobody = await r.h.api.get('bob@test.local', IDENTITY_ROUTE);
		expect(nobody.status).toBe(200);
		expect(nobody.body).toEqual({ pinned: null, published: null });
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

	it('acts on nothing when it cannot check my session, and tells me to try again', async () => {
		const notices = r.saying('Something went wrong on my side').length;
		await withoutTable(r, 'owner_cross_signing', async () => {
			const eventId = await r.client.sendText(r.room, 'Can you check this?');
			expect(await logged(r, 'owner device check failed', eventId)).toMatchObject({
				mode: 'enforce',
				via: 'message'
			});
			expect(await r.nextSaying('Something went wrong on my side', notices)).toBe(
				'Something went wrong on my side. Please try again in a moment.'
			);
		});
		const told = r.h.apisix.llm.calls.flatMap((c) => c.request.messages);
		expect(told.some((m) => m.role === 'user' && (m.content ?? '').includes('check this'))).toBe(
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
		// Words of each session the homeserver never received, which arrive under one new id: the words
		// acted on are those of the decryption that was checked
		const id = `$same-${Date.now()}`;
		const otherEvent = sealedEvent(r, id, await other.seal(r.room, 'Plan my week now'));
		const myEvent = sealedEvent(r, id, await r.client.seal(r.room, 'Good night again'));
		const answered = r.saying('Heard:').length;
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
		try {
			const first = push(r, [otherEvent]);
			await until(() => releases.length === 1, 'the first push held up');
			const second = push(r, [myEvent]);
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
		expect(await r.nextSaying('Heard:', answered)).toBe('Heard: Good night again');
		// Nothing of what the unverified session wrote ever reached the model
		const told = r.h.apisix.llm.calls.flatMap((c) => c.request.messages);
		expect(told.some((m) => m.role === 'user' && (m.content ?? '').includes('Plan my week'))).toBe(
			false
		);
	});

	it('takes a command only from the words of the very event whose session it checked', async () => {
		// A session I never verified sends my assistant's command, my verified session other words,
		// both under one new id the homeserver never saw: the words checked are mine, so they start a
		// turn, and no command is answered for the session it could not verify
		const other = await unverifiedSession(r, sessions);
		const id = `$command-${Date.now()}`;
		const otherEvent = sealedEvent(r, id, await other.seal(r.room, '!help'));
		const myEvent = sealedEvent(r, id, await r.client.seal(r.room, 'Good afternoon'));
		const answered = r.saying('Heard:').length;
		const helped = r.saying('I am your assistant.').length;
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
		try {
			const first = push(r, [otherEvent]);
			await until(() => releases.length === 1, 'the first push held up');
			const second = push(r, [myEvent]);
			await until(() => releases.length === 2, 'the second push held up');
			releases[0]?.();
			expect(await first).toBe(200);
			releases[1]?.();
			expect(await second).toBe(200);
		} finally {
			r.h.apisix.matrixHold = null;
			for (const release of releases) release();
		}
		expect((await r.h.decisionOn(id))?.['msg']).toBe('turn queued');
		expect(await r.nextSaying('Heard:', answered)).toBe('Heard: Good afternoon');
		await sleep(1000);
		expect(r.saying('I am your assistant.')).toHaveLength(helped);
	});

	it('acts on nothing written in clear in a room of mine that reads as clear', async () => {
		const clear = await clearRoom(r);
		const sent = await r.h.synapse.sendText(r.alice, clear, 'Plain hello');
		expect(await r.h.decisionOn(sent)).toMatchObject({
			msg: 'assistant ignored an unencrypted message',
			reason: 'clear room',
			mode: 'enforce'
		});
		expect(
			await r.h.synapse.waitForMessage(r.alice, clear, r.assistantId, (t) =>
				t.startsWith('I did not act on your last message: it reached me unencrypted')
			)
		).toBe(UNENCRYPTED_MESSAGE);
		const told = r.h.apisix.llm.calls.flatMap((c) => c.request.messages);
		expect(told.some((m) => m.role === 'user' && (m.content ?? '').includes('Plain hello'))).toBe(
			false
		);
	});

	it('checks my session the same when it reads my message again after its decryption failed', async () => {
		await readAgain(r, async () => {
			const heard = r.saying('Heard:').length;
			const eventId = await r.client.sendText(r.room, 'Read me again');
			expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Read me again');
			await logged(r, 'decryption failed', eventId);
			expect(await deviceLine(r, eventId)).toMatchObject({
				msg: 'owner device verified',
				deviceId: r.client.deviceId
			});
		});
		// A session I never verified, read again the same way, is not acted on: its key reaches the
		// assistant with its first words, refused as any of its words
		const other = await unverifiedSession(r, sessions);
		const first = await other.sendText(r.room, 'First words from elsewhere');
		expect((await r.h.decisionOn(first))?.['msg']).toBe('assistant ignored an unverified device');
		await readAgain(r, async () => {
			const eventId = await other.sendText(r.room, 'Read me again, from elsewhere');
			await logged(r, 'decryption failed', eventId);
			expect(await r.h.decisionOn(eventId)).toMatchObject({
				msg: 'assistant ignored an unverified device',
				deviceId: other.deviceId
			});
		});
		const told = r.h.apisix.llm.calls.flatMap((c) => c.request.messages);
		expect(told.some((m) => m.role === 'user' && (m.content ?? '').includes('elsewhere'))).toBe(
			false
		);
	});

	it('acts on nothing from an account without any identity, and tells me how to set one up', async () => {
		const carol = await r.h.synapse.registerUser('carol');
		const client = await startE2eeClient(r.h.synapse.url, carol, { session: 'unsigned' });
		sessions.push(client);
		const created = await r.h.api.post<{ roomId: string }>('carol@test.local', '/v1/assistants', {
			name: 'Iris'
		});
		expect(created.status).toBe(201);
		const room = created.body.roomId;
		for (let i = 0; i < 40; i += 1) {
			const invites = await r.h.synapse.pendingInvites(carol);
			if (invites.some((inv) => inv.roomId === room)) break;
			await sleep(250);
		}
		await client.joinRoom(room);
		const assistantId = '@twake-space-assistant-carol:test.local';
		await client.waitForMessage(room, assistantId, (t) => t.includes('Iris'));
		expect(await client.masterKey()).toBeNull();
		const eventId = await client.sendText(room, 'Hello Iris');
		expect(await r.h.decisionOn(eventId)).toMatchObject({
			msg: 'assistant ignored an unverified device',
			deviceId: client.deviceId,
			signed: false,
			identity: 'none',
			matchesPin: false
		});
		expect(
			await client.waitForMessage(room, assistantId, (t) =>
				t.startsWith('I did not act on your last message: your account has no encryption')
			)
		).toBe(NO_IDENTITY_MESSAGE);
		const held = await withPrincipal(
			r.h.db,
			{ id: 'carol@test.local' },
			(tx) => tx.sql`select 1 from owner_cross_signing where owner = 'carol@test.local'`
		);
		expect(held).toHaveLength(0);
	});

	it('takes an earlier yes of mine, sent again under another id, for no answer', async () => {
		// A first question, which my yes answers
		let seen = r.questions().length;
		await r.client.sendText(r.room, 'Find the plan in my drive');
		await r.nextQuestion(seen);
		const found = r.saying('Found:').length;
		const yes = await r.client.sendText(r.room, 'oui');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/drive/items');
		const earlierYes = await encryptedEvent(r, yes);
		// A second question, which the same yes comes again to, under another id
		seen = r.questions().length;
		await r.client.sendText(r.room, 'Search my notes');
		await r.nextQuestion(seen);
		const copy = `$copy-${Date.now()}`;
		expect(await push(r, [{ ...earlierYes, event_id: copy }])).toBe(200);
		expect(await r.h.decisionOn(copy)).toMatchObject({
			msg: 'assistant ignored a copy of earlier words',
			mode: 'enforce',
			firstEventId: yes
		});
		expect((await r.callsTo('notes')).map((c) => c.status)).toEqual(['open']);
		expect(r.h.apisix.contracts.calls.some((c) => c.path.includes('/notes/'))).toBe(false);
		// My own answer to it still counts
		const refused = r.saying('All right').length;
		await r.client.sendText(r.room, 'non');
		expect(await r.nextSaying('All right', refused)).toBe('All right, I will not do it.');
	});

	it('takes a reaction for an answer only by the question its encrypted content names', async () => {
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'List my tasks');
		const question = await r.nextQuestion(seen);
		// A no that names the question only in its clear part answers nothing
		const inClear = await r.client.reactInClear(r.room, question, '❌');
		await logged(r, 'answer ignored: not the event checked', inClear);
		expect((await r.callsTo('tasks')).map((c) => c.status)).toEqual(['open']);
		// One whose encrypted content names it answers it
		const found = r.saying('Found:').length;
		await r.client.react(r.room, question, '✅');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/tasks/items');
	});

	it('takes no words of a session it first saw over a month ago, and tells me to start a new one', async () => {
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Recent words');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Recent words');
		const notices = r.saying('I did not act on your last message: your app').length;
		await sessionsAMonthOld(r, async () => {
			const eventId = await r.client.sendText(r.room, 'Words of an old session');
			expect(await r.h.decisionOn(eventId)).toMatchObject({
				msg: 'assistant ignored words of an old session',
				mode: 'enforce',
				deviceId: r.client.deviceId
			});
			expect(await r.nextSaying('I did not act on your last message: your app', notices)).toBe(
				OLD_SESSION_MESSAGE
			);
		});
		const told = r.h.apisix.llm.calls.flatMap((c) => c.request.messages);
		expect(told.some((m) => m.role === 'user' && (m.content ?? '').includes('old session'))).toBe(
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
		// It asks me nothing to answer: no message of mine can make it hold another identity
		const notice = r.saying('I did not act on your last message').at(-1);
		expect(notice?.content).not.toHaveProperty([QUESTION_CONTENT_KEY]);
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

	it('acts on what I write in clear in a room of mine that reads as clear, and logs it', async () => {
		const clear = await clearRoom(r);
		const sent = await r.h.synapse.sendText(r.alice, clear, 'Plain hello');
		expect((await r.h.decisionOn(sent))?.['msg']).toBe('turn queued');
		expect(await logged(r, 'owner message unencrypted', sent)).toMatchObject({
			reason: 'clear room',
			mode: 'report'
		});
		expect(
			await r.h.synapse.waitForMessage(r.alice, clear, r.assistantId, (t) => t.startsWith('Heard:'))
		).toBe('Heard: Plain hello');
	});

	it('acts on my words after my identity changed all the same, and asks me whether I reset it', async () => {
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
			CHANGED_QUESTION
		);
		const question = r.saying('Your encryption identity is not the one I know').at(-1);
		expect(question?.content).toHaveProperty([QUESTION_CONTENT_KEY]);
		const view = await r.h.api.get(OWNER, IDENTITY_ROUTE);
		expect(view.body).toMatchObject({
			pinned: { master_key: before },
			published: { master_key: after }
		});
	});

	it('starts no second turn from a copy of my message, even while it only reports', async () => {
		const heard = r.saying('Heard:').length;
		const once = await r.client.sendText(r.room, 'Once only');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Once only');
		const copy = `$copy-${Date.now()}`;
		expect(await push(r, [{ ...(await encryptedEvent(r, once)), event_id: copy }])).toBe(200);
		expect(await r.h.decisionOn(copy)).toMatchObject({
			msg: 'assistant ignored a copy of earlier words',
			mode: 'report',
			firstEventId: once
		});
		// The next message is answered, and that one only once
		const next = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'And the next');
		expect(await r.nextSaying('Heard:', next)).toBe('Heard: And the next');
		expect(r.saying('Heard: Once only')).toHaveLength(1);
	});

	it('takes no copy of my message when it cannot tell copies apart', async () => {
		const heard = r.saying('Heard:').length;
		const once = await r.client.sendText(r.room, 'Only this once');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Only this once');
		const copyOfOnce = await encryptedEvent(r, once);
		const notices = r.saying('Something went wrong on my side').length;
		await withoutTable(r, 'owner_words_received', async () => {
			const copy = `$copy-${Date.now()}`;
			expect(await push(r, [{ ...copyOfOnce, event_id: copy }])).toBe(200);
			expect(await logged(r, 'owner device check failed', copy)).toMatchObject({
				mode: 'report'
			});
			expect(await r.nextSaying('Something went wrong on my side', notices)).toBe(
				'Something went wrong on my side. Please try again in a moment.'
			);
		});
		const next = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Back to normal');
		expect(await r.nextSaying('Heard:', next)).toBe('Heard: Back to normal');
		expect(r.saying('Heard: Only this once')).toHaveLength(1);
	});

	it('takes nothing a copy carries once its session is older than what it remembers', async () => {
		const heard = r.saying('Heard:').length;
		const earlier = await r.client.sendText(r.room, 'Before the month');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Before the month');
		// A month later as the harness sees it: what it kept of those words is forgotten, and their
		// session was first received a month ago
		await withPrincipal(r.h.db, { id: OWNER }, async (tx) => {
			await tx.sql`
				update owner_words_received set received_at = now() - interval '31 days'
				where owner = ${OWNER}`;
			await tx.sql`
				update owner_megolm_sessions set first_seen_at = now() - interval '31 days'
				where owner = ${OWNER}`;
		});
		try {
			const copy = `$late-copy-${Date.now()}`;
			expect(await push(r, [{ ...(await encryptedEvent(r, earlier)), event_id: copy }])).toBe(200);
			expect(await r.h.decisionOn(copy)).toMatchObject({
				msg: 'assistant ignored words of an old session',
				mode: 'report'
			});
		} finally {
			await withPrincipal(
				r.h.db,
				{ id: OWNER },
				(tx) =>
					tx.sql`update owner_megolm_sessions set first_seen_at = now() where owner = ${OWNER}`
			);
		}
		const next = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Still here');
		expect(await r.nextSaying('Heard:', next)).toBe('Heard: Still here');
		expect(r.saying('Heard: Before the month')).toHaveLength(1);
	});

	it('takes my words when its check fails only after it decrypted them', async () => {
		const notices = r.saying('Something went wrong on my side').length;
		const heard = r.saying('Heard:').length;
		await withoutTable(r, 'owner_cross_signing', async () => {
			const eventId = await r.client.sendText(r.room, 'Checked half way');
			expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Checked half way');
			await logged(r, 'owner device check failed', eventId);
		});
		expect(r.saying('Something went wrong on my side')).toHaveLength(notices);
	});

	it('tells me again a minute later when it still cannot check my words', async () => {
		const notices = r.saying('Something went wrong on my side').length;
		await withoutTable(r, 'owner_words_received', async () => {
			await lastToldAMinuteAgo(r);
			const first = await r.client.sendText(r.room, 'First try');
			await logged(r, 'owner device check failed', first);
			expect(await r.nextSaying('Something went wrong on my side', notices)).toBe(
				'Something went wrong on my side. Please try again in a moment.'
			);
			await lastToldAMinuteAgo(r);
			const second = await r.client.sendText(r.room, 'Second try');
			await logged(r, 'owner device check failed', second);
			expect(await r.nextSaying('Something went wrong on my side', notices + 1)).toBe(
				'Something went wrong on my side. Please try again in a moment.'
			);
		});
		expect(r.saying('Heard: First try')).toHaveLength(0);
		expect(r.saying('Heard: Second try')).toHaveLength(0);
	});

	it('counts a session from the first of its words it could decrypt', async () => {
		// A session of mine whose first words the check fails to decrypt
		const other = await startE2eeClient(r.h.synapse.url, await r.h.synapse.login('alice'));
		sessions.push(other);
		const eventId = `$undecrypted-${Date.now()}`;
		const event = sealedEvent(r, eventId, await other.seal(r.room, 'Words it cannot decrypt'));
		const sessionId = String(Reflect.get(event['content'] as object, 'session_id'));
		await decryptedOnce(eventId, async () => {
			expect(await push(r, [event])).toBe(200);
			await logged(r, 'owner device check failed', eventId);
		});
		expect(await firstSeen(r, sessionId)).toBeNull();
		expect(r.saying('Heard: Words it cannot decrypt')).toHaveLength(0);
		// Its next words are the first it takes
		const heard = r.saying('Heard:').length;
		await other.sendText(r.room, 'Words it decrypts');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Words it decrypts');
		expect(await firstSeen(r, sessionId)).not.toBeNull();
	});

	it('takes no fresh words of a session it first saw over a month ago, and tells me to start a new one', async () => {
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Words of the day');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Words of the day');
		const notices = r.saying('I did not act on your last message: your app').length;
		await sessionsAMonthOld(r, async () => {
			const eventId = await r.client.sendText(r.room, 'Fresh words of an old session');
			expect(await r.h.decisionOn(eventId)).toMatchObject({
				msg: 'assistant ignored words of an old session',
				mode: 'report',
				deviceId: r.client.deviceId
			});
			expect(await r.nextSaying('I did not act on your last message: your app', notices)).toBe(
				OLD_SESSION_MESSAGE
			);
		});
		expect(r.saying('Heard: Fresh words of an old session')).toHaveLength(0);
	});

	it('holds a room I open with my assistant myself, and its commands, to the same rule', async () => {
		// As Twake Chat's « My assistant »: an encrypted direct room, the assistant invited, which it
		// joins and keeps as one of its rooms
		const room = await r.client.createDirectRoom(r.assistantId);
		for (let i = 0; i < 120; i += 1) {
			if ((await r.h.synapse.joinedMembers(r.alice, room)).includes(r.assistantId)) break;
			await sleep(250);
		}
		const said = (prefix: string): string[] =>
			r.client.messages
				.filter((m) => m.roomId === room && m.sender === r.assistantId && m.body.startsWith(prefix))
				.map((m) => m.body);
		const helped = await r.client.sendText(room, '!help');
		expect((await r.h.decisionOn(helped))?.['msg']).toBe('assistant command answered');
		await until(() => said('I am your assistant.').length === 1, 'the help answer');
		// A check that fails before it decrypts: no answer, and I am told to try again
		await lastToldAMinuteAgo(r);
		await withoutTable(r, 'owner_words_received', async () => {
			const eventId = await r.client.sendText(room, '!help');
			await logged(r, 'owner device check failed', eventId);
			await until(() => said('Something went wrong on my side').length === 1, 'the notice');
		});
		// A session first decrypted a month ago: no answer, and I am told to start a new one
		await lastToldAMinuteAgo(r);
		await sessionsAMonthOld(r, async () => {
			const eventId = await r.client.sendText(room, '!help');
			expect(await r.h.decisionOn(eventId)).toMatchObject({
				msg: 'assistant ignored words of an old session',
				mode: 'report'
			});
			await until(() => said('I did not act on your last message: your app').length === 1, 'it');
		});
		expect(said('I did not act on your last message: your app')).toEqual([OLD_SESSION_MESSAGE]);
		expect(said('I am your assistant.')).toHaveLength(1);
	});

	it('tells me to write from a session my new identity signed, or to verify this one, so that it can ask me about it', async () => {
		const held = (await r.h.api.get(OWNER, IDENTITY_ROUTE)).body['pinned'];
		// Another session of mine replaces my identity with a new one that signs it alone
		const other = await startE2eeClient(r.h.synapse.url, await r.h.synapse.login('alice'));
		sessions.push(other);
		await other.resetIdentity();
		// My words from my first session, which the new identity did not sign, are acted on, and I am
		// told what to do, with nothing to answer
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'From my first session');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: From my first session');
		expect(await r.nextSaying('Your encryption identity changed', 0)).toBe(UNSIGNED_REPORT);
		const notice = r.saying('Your encryption identity changed').at(-1);
		expect(notice?.content).not.toHaveProperty([QUESTION_CONTENT_KEY]);
		// From the session it signed, my assistant asks me
		const asked = r.saying('Your encryption identity is not the one I know').length;
		await other.sendText(r.room, 'From the session it signed');
		expect(await r.nextSaying('Your encryption identity is not the one I know', asked)).toBe(
			CHANGED_QUESTION
		);
		expect((await r.h.api.get(OWNER, IDENTITY_ROUTE)).body['pinned']).toEqual(held);
	});
});
