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
	'I did not act on your last message: your encryption identity is not the one I know, so I act on none of your messages for now.';
const UNVERIFIED_REPORT =
	'This session of yours is not verified. I act on what you write from it for now; verify it so that I keep doing so: in another of your Twake Chat sessions, open Settings > Devices, find this one marked Unverified and tap Verify.';
const CHANGED_REPORT =
	'Your encryption identity is not the one I know. I act on what you write for now.';

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

	it('acts on none of my words once my identity changed, and tells me', async () => {
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

	it('acts on my words after my identity changed all the same, and tells me so', async () => {
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
	});
});
