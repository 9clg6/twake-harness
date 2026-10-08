import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withPrincipal } from '../src/db/client.js';
import { buildRegistration } from '../src/matrix/registration.js';
import { makeSpaceNotifications } from '../src/suggestions/space.js';
import { grantConsent } from './helpers/consents.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import {
	CALENDAR_CATALOG,
	type ChatRequest,
	type ContractCall,
	type ScriptedReply
} from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import { startFakeSpace, type FakeSpace } from './helpers/space.js';
import type { MatrixUser } from './helpers/synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(
	read: () => T | null | undefined | false | Promise<T | null | undefined | false>,
	ms = 30_000
): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const found = await read();
		if (found !== null && found !== undefined && found !== false) return found;
		if (Date.now() > end) throw new Error('timed out');
		await sleep(150);
	}
}

const ALICE = 'alice@test.local';
const BOB = 'bob@test.local';
const CAROL = 'carol@test.local';
const DAVE = 'dave@test.local';

// The model, as a literal one: for the owner whose assistant it speaks as, it prepares a meeting on
// Monday with the other person, then says nothing more
let proposals = 0;
const proposeMonday = (request: ChatRequest): ScriptedReply => {
	const system = request.messages[0]?.content ?? '';
	const owner = /whose address is (\S+?)\.\s/.exec(system)?.[1] ?? '';
	if (request.messages.at(-1)?.role === 'tool') return { content: 'NONE' };
	proposals += 1;
	// Told that the user declined the slot, it chooses the next one
	const declined = request.messages.some((m) => (m.content ?? '').includes('<<<declined-proposal'));
	const other = (system.match(/[\w.-]+@test\.local/g) ?? []).find((p) => p !== owner) ?? BOB;
	return {
		content: 'Vous avez un créneau lundi.',
		toolCalls: [
			{
				id: `call_${proposals}`,
				type: 'function',
				function: {
					name: 'create_meeting',
					arguments: JSON.stringify({
						body: {
							title: 'Point lundi',
							start: declined ? '2026-10-12T10:00:00+02:00' : '2026-10-12T09:30:00+02:00',
							end: declined ? '2026-10-12T10:15:00+02:00' : '2026-10-12T09:45:00+02:00',
							attendees: [other]
						}
					})
				}
			}
		]
	};
};

describe('the assistant proposes from the messages of channels', () => {
	let h: MatrixTestHarness;
	let space: FakeSpace;
	const users = new Map<string, MatrixUser>();
	let alice: MatrixUser;
	let bob: MatrixUser;
	let aliceClient: E2eeClient;
	let bobClient: E2eeClient;
	let channel: string;

	const llmCalls = (): number => h.apisix.llm.calls.length;
	const say = (user: MatrixUser, room: string, text: string): Promise<string> =>
		h.synapse.sendText(user, room, text);
	let space_: string;
	const LISTENER = '@twake-assistant:test.local';
	const ENCRYPTION = {
		type: 'm.room.encryption',
		state_key: '',
		content: { algorithm: 'm.megolm.v1.aes-sha2' }
	};
	const PARENT = (): Record<string, unknown> => ({
		type: 'm.space.parent',
		state_key: space_,
		content: { via: ['test.local'], canonical: true }
	});
	const create = async (owner: MatrixUser, body: Record<string, unknown>): Promise<string> =>
		(await h.synapse.request(owner, 'POST', '/_matrix/client/v3/createRoom', body)).body[
			'room_id'
		] as string;
	// Whether the listener is in the room, once it had time to answer an invite
	async function listenerJoined(owner: MatrixUser, room: string, wait = 6000): Promise<boolean> {
		const end = Date.now() + wait;
		while (Date.now() < end) {
			if ((await h.synapse.joinedMembers(owner, room)).includes(LISTENER)) return true;
			await sleep(300);
		}
		return false;
	}
	// Whether the listener is still in a room it was invited to once it had time to join and leave
	async function listenerStays(owner: MatrixUser, room: string): Promise<boolean> {
		await sleep(5000);
		return (await h.synapse.joinedMembers(owner, room)).includes(LISTENER);
	}
	const invite = (owner: MatrixUser, room: string): Promise<unknown> =>
		h.synapse.request(
			owner,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`,
			{ user_id: LISTENER }
		);
	// A channel: a room inside a space, as Twake Chat writes it (m.space.parent on the room), where
	// the listener was invited and joined
	async function openChannel(owner: MatrixUser, members: MatrixUser[]): Promise<string> {
		const room = await create(owner, {
			preset: 'public_chat',
			name: 'general',
			initial_state: [PARENT()]
		});
		for (const member of members) await h.synapse.joinRoom(member, room);
		await invite(owner, room);
		expect(await listenerJoined(owner, room, 30_000)).toBe(true);
		return room;
	}
	async function becomeAssistantOwner(localpart: string): Promise<MatrixUser> {
		const user = await h.synapse.registerUser(localpart);
		users.set(localpart, user);
		const principal = `${localpart}@test.local`;
		const created = await h.api.post(principal, '/v1/assistants', {
			name: `Assistant ${localpart}`
		});
		expect(created.status).toBe(201);
		// No room of its own with its owner: the suggestion reaches Space alone
		await h.db.sql`update assistants set room_id = null where owner = ${principal}`;
		await grantConsent(h.db, principal, 'calendar', 'read');
		return user;
	}

	beforeAll(async () => {
		space = await startFakeSpace();
		h = await startMatrixHarness({
			env: {
				SPACE_API_URL: space.url,
				SPACE_API_TOKEN: 'tws_secret',
				ASSISTANT_TIMEZONE: 'Europe/Paris'
			}
		});
		h.apisix.contracts.spec = CALENDAR_CATALOG;
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(4);
		h.apisix.llm.script = proposeMonday;
		alice = await becomeAssistantOwner('alice');
		bob = await becomeAssistantOwner('bob');
		const parent = await h.synapse.request(bob, 'POST', '/_matrix/client/v3/createRoom', {
			preset: 'public_chat',
			name: 'space',
			creation_content: { type: 'm.space' }
		});
		space_ = parent.body['room_id'] as string;
		channel = await openChannel(bob, [alice]);
		aliceClient = await startE2eeClient(h.synapse.url, alice);
		bobClient = await startE2eeClient(h.synapse.url, bob);
		// The assistants' rooms are settled by now: Alice and Bob have none, for Space alone
		await sleep(3000);
		await h.db.sql`update assistants set room_id = null where owner in (${ALICE}, ${BOB})`;
	}, 300_000);
	afterAll(async () => {
		if (aliceClient !== undefined) await aliceClient.stop();
		if (bobClient !== undefined) await bobClient.stop();
		if (h !== undefined) await h.close();
		if (space !== undefined) await space.close();
	});

	it('asks Synapse for no room, but for the listener user among the exclusive ones', async () => {
		const registration = buildRegistration(h.config, 'http://harness');
		expect(registration.namespaces.rooms).toEqual([]);
		const users = registration.namespaces.users.map((u) => u.regex).join(' ');
		expect(users).toContain('twake-assistant');
		expect(registration.namespaces.users.every((u) => u.exclusive)).toBe(true);
		expect((await h.synapse.joinedMembers(bob, channel)).sort()).toEqual([
			'@alice:test.local',
			'@bob:test.local',
			LISTENER
		]);
		expect(await h.synapse.displayName(LISTENER)).toBe('Twake Assistant');
	});

	it('sends nothing to the model for a message that is no arrangement to meet', async () => {
		const before = llmCalls();
		await say(alice, channel, 'merci pour le document');
		await say(bob, channel, 'lundi je suis en congé');
		await sleep(3000);
		expect(llmCalls()).toBe(before);
		expect(space.calls).toHaveLength(0);
	});

	it('proposes to the sender and to the author of the message before, in their Space only, and keeps no quote', async () => {
		await say(alice, channel, 'On se voit quand ?');
		const eventId = await say(bob, channel, 'ok on parle lundi');
		const calls = await until(() => (space.calls.length >= 2 ? space.calls : null));
		const byUser = new Map(calls.map((c) => [c.body['matrixUserId'] as string, c]));
		expect([...byUser.keys()].sort()).toEqual(['@alice:test.local', '@bob:test.local']);
		const forAlice = byUser.get('@alice:test.local');
		expect(forAlice?.path).toBe('/api/notifications/suggestions');
		expect(forAlice?.authorization).toBe('Bearer tws_secret');
		const pendingCallId = forAlice?.body['pendingCallId'];
		expect(forAlice?.body).toEqual({
			matrixUserId: '@alice:test.local',
			externalId: pendingCallId,
			text: expect.stringContaining('bob@test.local'),
			pendingCallId,
			matrixRoomId: channel
		});
		expect(String(forAlice?.body['text'])).toContain('Point lundi');
		expect(String(forAlice?.body['text']).length).toBeLessThanOrEqual(500);
		// The model read both messages, marked as data, with their authors
		const asked = h.apisix.llm.calls.map((c) =>
			c.request.messages.map((m) => m.content ?? '').join('\n')
		);
		expect(
			asked.some(
				(t) =>
					t.includes('<<<channel-messages') &&
					t.includes('On se voit quand') &&
					t.includes('ok on parle lundi')
			)
		).toBe(true);
		// ...and nothing of them is kept: no session, no memory, no job
		expect(await h.db.sql`select 1 from sessions`).toHaveLength(0);
		expect(await h.db.sql`select 1 from memory_entries`).toHaveLength(0);
		await until(
			async () => (await h.db.sql`select 1 from jobs where kind = 'suggest'`).length === 0,
			1
		);
		expect(JSON.stringify(await h.db.sql`select payload from jobs`)).not.toContain(
			'ok on parle lundi'
		);
		// Nothing was written in the calendar, and the assistant never joined the channel
		expect(h.apisix.contracts.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
		expect(await h.synapse.joinedMembers(bob, channel)).not.toContain(
			expect.stringContaining('assistant')
		);
		void eventId;
		// The write waits for its owner whatever they allowed
		const waiting = await h.api.get<{
			pending_calls: { id: string; reasons: string[]; channel: string }[];
		}>(ALICE, '/v1/pending-calls');
		expect(waiting.body.pending_calls).toHaveLength(1);
		expect(waiting.body.pending_calls[0]?.reasons).toContain('high_risk');
		expect(waiting.body.pending_calls[0]?.channel).toBe('api_tool');
	});

	it('creates the meeting on one click of the owner, in their name', async () => {
		const call = space.calls.find((c) => c.body['matrixUserId'] === '@alice:test.local');
		const id = call?.body['pendingCallId'] as string;
		h.apisix.contracts.handler = (c: ContractCall) => ({
			status: 200,
			body: { uid: 'm-1', echo: c.method }
		});
		const approved = await h.api.post(ALICE, `/v1/pending-calls/${id}/approve`, {});
		expect(approved.status).toBe(200);
		const posted = h.apisix.contracts.calls.filter((c) => c.method === 'POST');
		expect(posted).toHaveLength(1);
		expect(posted[0]?.path).toBe('/contracts/v1/calendar/meetings');
		expect(posted[0]?.headers['x-twake-on-behalf-of']).toBe(ALICE);
		expect(posted[0]?.body).toMatchObject({ title: 'Point lundi', attendees: [BOB] });
	});

	it('proposes once a day at most three times, and once per room per twelve hours', async () => {
		// Alice has one suggestion from the channel now: another message in it proposes nothing to her
		const before = space.calls.length;
		await say(bob, channel, 'on se voit mardi à 10h ?');
		await sleep(3000);
		expect(
			space.calls.slice(before).filter((c) => c.body['matrixUserId'] === '@alice:test.local')
		).toHaveLength(0);
		// Three in a day is the most
		await withPrincipal(h.db, { id: ALICE }, async (tx) => {
			for (let i = 0; i < 2; i += 1) {
				await tx.sql`insert into suggestions (pending_call_id, owner, room_id, starts_at, ends_at)
					values (gen_random_uuid(), ${ALICE}, ${`!other${i}:test.local`}, now(), now())`;
			}
		});
		const other = await openChannel(bob, [alice]);
		const calls = llmCalls();
		await say(bob, other, 'on se voit mercredi à 10h ?');
		await sleep(3000);
		expect(
			space.calls.slice(before).filter((c) => c.body['matrixUserId'] === '@alice:test.local')
		).toHaveLength(0);
		void calls;
	});

	it('leaves alone a room muted by its member, and the words of a member who opted out', async () => {
		const settings = await h.api.get<{ enabled: boolean; mutedRooms: string[] }>(
			CAROL,
			'/v1/suggestions/settings'
		);
		expect(settings.body).toEqual({ enabled: true, mutedRooms: [] });
		const carol = await becomeAssistantOwner('carol');
		const dave = await becomeAssistantOwner('dave');
		const room = await openChannel(carol, [dave]);
		expect(
			(await h.api.put(DAVE, '/v1/suggestions/settings', { enabled: true, mutedRooms: [room] }))
				.body
		).toEqual({
			enabled: true,
			mutedRooms: [room]
		});
		const before = space.calls.length;
		await say(dave, room, 'On se voit quand ?');
		await say(carol, room, 'on se voit lundi à 10h ?');
		await until(() => space.calls.length > before);
		await sleep(1500);
		// Dave muted the room: only Carol hears of it
		const carolOnly = space.calls.slice(before);
		expect(carolOnly.map((c) => c.body['matrixUserId'])).toEqual(['@carol:test.local']);
		// Carol turns suggestions off: her messages are read no more, nor quoted for Dave
		await h.api.put(CAROL, '/v1/suggestions/settings', { enabled: false, mutedRooms: [] });
		await h.api.put(DAVE, '/v1/suggestions/settings', { enabled: true, mutedRooms: [] });
		const calls = llmCalls();
		await say(dave, room, 'Quand ?');
		await say(carol, room, 'on se call mardi à 14h ?');
		await sleep(3000);
		expect(llmCalls()).toBe(calls);
	});

	it('tries another time once, and mutes the room for a week when it is not useful', async () => {
		const erin = await becomeAssistantOwner('erin');
		const room = await openChannel(erin, [bob]);
		const before = space.calls.length;
		await say(bob, room, 'On se voit quand ?');
		await say(erin, room, 'on se voit lundi à 10h ?');
		const first = await until(() =>
			space.calls.slice(before).find((c) => c.body['matrixUserId'] === '@erin:test.local')
		);
		const firstId = first.body['pendingCallId'] as string;
		const asked = llmCalls();
		const refused = await h.api.post('erin@test.local', `/v1/pending-calls/${firstId}/refuse`, {
			reason: 'another_time'
		});
		expect(refused.status).toBe(200);
		const retry = await until(() =>
			space.calls
				.slice(before)
				.find(
					(c) =>
						c.body['matrixUserId'] === '@erin:test.local' && c.body['pendingCallId'] !== firstId
				)
		);
		const retryRequest = h.apisix.llm.calls
			.slice(asked)
			.map((c) => c.request.messages.map((m) => m.content ?? '').join('\n'));
		expect(retryRequest.some((t) => t.includes('<<<declined-proposal'))).toBe(true);
		// A second refusal for another time is not tried again
		const calls = llmCalls();
		await h.api.post(
			'erin@test.local',
			`/v1/pending-calls/${retry.body['pendingCallId'] as string}/refuse`,
			{
				reason: 'another_time'
			}
		);
		await sleep(3000);
		expect(llmCalls()).toBe(calls);
		// Not useful: the room is muted for that member
		const other = await openChannel(erin, [bob]);
		await withPrincipal(h.db, { id: 'erin@test.local' }, (tx) => tx.sql`delete from suggestions`);
		await say(bob, other, 'On se voit quand ?');
		await say(erin, other, 'on se voit jeudi à 10h ?');
		const third = await until(() =>
			space.calls.find(
				(c) => c.body['matrixRoomId'] === other && c.body['matrixUserId'] === '@erin:test.local'
			)
		);
		await h.api.post(
			'erin@test.local',
			`/v1/pending-calls/${third.body['pendingCallId'] as string}/refuse`,
			{
				reason: 'not_useful'
			}
		);
		const settings = await h.api.get<{ mutedRooms: string[] }>(
			'erin@test.local',
			'/v1/suggestions/settings'
		);
		expect(settings.body.mutedRooms).toEqual([other]);
		const muted = await withPrincipal(
			h.db,
			{ id: 'erin@test.local' },
			(tx) => tx.sql<{ days: number }[]>`
				select round(extract(epoch from until - now()) / 86400)::int as days
				from suggestion_mutes where room_id = ${other}`
		);
		expect(muted[0]?.days).toBe(7);
	});

	it("also asks in the owner's room with their assistant, where a yes creates the meeting", async () => {
		const fred = await h.synapse.registerUser('fred');
		const created = await h.api.post<{ roomId: string }>('fred@test.local', '/v1/assistants', {
			name: 'Jarvis'
		});
		const dm = created.body.roomId;
		await grantConsent(h.db, 'fred@test.local', 'calendar', 'read');
		const client = await startE2eeClient(h.synapse.url, fred);
		try {
			await until(async () => (await h.synapse.pendingInvites(fred)).some((i) => i.roomId === dm));
			await client.joinRoom(dm);
			await client.waitForMessage(dm, '@twake-space-assistant-fred:test.local', (t) =>
				t.includes('Jarvis')
			);
			const room = await openChannel(bob, [fred]);
			await say(bob, room, 'On se voit quand ?');
			await say(fred, room, 'on se voit lundi à 10h ?');
			await client.waitForMessage(dm, '@twake-space-assistant-fred:test.local', (t) =>
				t.includes('> Vous avez un créneau lundi.')
			);
			h.apisix.contracts.handler = () => ({ status: 200, body: { uid: 'm-2' } });
			const posts = (): number =>
				h.apisix.contracts.calls.filter((c) => c.method === 'POST').length;
			const before = posts();
			await client.client.sendText(dm, 'oui');
			await until(() => posts() > before);
			const meeting = h.apisix.contracts.calls.filter((c) => c.method === 'POST').at(-1);
			expect(meeting?.body).toMatchObject({ attendees: [BOB] });
			expect(meeting?.headers['x-twake-on-behalf-of']).toBe('fred@test.local');
		} finally {
			await client.stop();
		}
	});

	describe('which rooms the listener accepts', () => {
		async function heardBy(room: string, from: MatrixUser[], text: string): Promise<boolean> {
			const calls = llmCalls();
			for (const user of from)
				await say(user, room, user === from.at(-1) ? text : 'On se voit quand ?');
			await sleep(3500);
			return llmCalls() > calls;
		}
		async function pair(): Promise<[MatrixUser, MatrixUser]> {
			const tag = Math.random().toString(36).slice(2, 7);
			return [await becomeAssistantOwner(`p${tag}`), await becomeAssistantOwner(`q${tag}`)];
		}
		const matching = 'ok on parle lundi à 10h';

		// The invite of a direct room carries is_direct; a direct room of Twake Chat is also
		// encrypted, which the stripped state shows
		it('declines an invite to a direct room', async () => {
			const [one] = await pair();
			const dm = await create(one, {
				preset: 'trusted_private_chat',
				is_direct: true,
				invite: [LISTENER]
			});
			expect(await listenerStays(one, dm)).toBe(false);
		});

		it('accepts a room outside any space, stays, and reads it', async () => {
			const [one, two] = await pair();
			const room = await create(one, { preset: 'public_chat', name: 'loose' });
			await h.synapse.joinRoom(two, room);
			await invite(one, room);
			expect(await listenerStays(one, room)).toBe(true);
			expect(await heardBy(room, [two, one], matching)).toBe(true);
		});

		it('accepts a room inside a space, and reads it', async () => {
			const [one, two] = await pair();
			const room = await openChannel(one, [two]);
			expect(await heardBy(room, [two, one], matching)).toBe(true);
		});

		it('accepts a space itself, and reads it', async () => {
			const [one, two] = await pair();
			const room = await create(one, {
				preset: 'public_chat',
				creation_content: { type: 'm.space' }
			});
			await h.synapse.joinRoom(two, room);
			await invite(one, room);
			expect(await listenerJoined(one, room)).toBe(true);
			expect(await heardBy(room, [two, one], matching)).toBe(true);
		});

		it('declines an encrypted space and an encrypted room inside a space', async () => {
			const [one, two] = await pair();
			const space = await create(one, {
				preset: 'public_chat',
				creation_content: { type: 'm.space' },
				initial_state: [ENCRYPTION]
			});
			await invite(one, space);
			expect(await listenerStays(one, space)).toBe(false);
			const inside = await create(one, {
				preset: 'public_chat',
				initial_state: [PARENT(), ENCRYPTION]
			});
			await h.synapse.joinRoom(two, inside);
			await invite(one, inside);
			expect(await listenerStays(one, inside)).toBe(false);
			expect(await heardBy(inside, [two, one], matching)).toBe(false);
		});

		it('leaves a room at once when it turns encrypted', async () => {
			const [one, two] = await pair();
			const room = await openChannel(one, [two]);
			await h.synapse.request(
				one,
				'PUT',
				`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.room.encryption`,
				ENCRYPTION.content
			);
			const end = Date.now() + 15_000;
			while (Date.now() < end && (await h.synapse.joinedMembers(one, room)).includes(LISTENER)) {
				await sleep(300);
			}
			expect(await h.synapse.joinedMembers(one, room)).not.toContain(LISTENER);
			expect(await heardBy(room, [two, one], matching)).toBe(false);
		});

		it('stops reading a room once the listener is kicked, which is its switch', async () => {
			const [one, two] = await pair();
			const room = await openChannel(one, [two]);
			await h.synapse.request(
				one,
				'POST',
				`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/kick`,
				{ user_id: LISTENER }
			);
			await sleep(1500);
			expect(await heardBy(room, [two, one], matching)).toBe(false);
		});

		it('never posts anything in a channel', async () => {
			const messages = await h.synapse.messagesFrom(bob, channel, LISTENER);
			expect(messages).toEqual([]);
		});
	});
});

describe('the notification to Twake Space', () => {
	const suggestion = {
		matrixUserId: '@alice:test.local',
		externalId: 'c-1',
		text: 'x'.repeat(600),
		pendingCallId: 'c-1',
		matrixRoomId: '!r:test.local'
	};
	const reply = (status: number, body: unknown): typeof fetch =>
		(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
	const log = { warn: () => undefined } as never;
	const make = (fetchImpl: typeof fetch) =>
		makeSpaceNotifications({
			apiUrl: new URL('http://space.test/api'),
			apiToken: 'tws_x',
			log,
			fetchImpl
		});

	it('takes 201 for done, and 200 with no id for a user who turned suggestions off in Space', async () => {
		expect(await make(reply(201, { id: 'n' })).suggest(suggestion)).toBe('created');
		expect(await make(reply(200, { id: null })).suggest(suggestion)).toBe('off');
		expect(await make(reply(200, { id: 'n' })).suggest(suggestion)).toBe('created');
	});

	it('logs, and fails, on an unknown user, a session token or a broken Space', async () => {
		expect(await make(reply(404, { error: 'unknown_user' })).suggest(suggestion)).toBe('failed');
		expect(await make(reply(403, {})).suggest(suggestion)).toBe('failed');
		const down = (async () => {
			throw new Error('connect ECONNREFUSED');
		}) as unknown as typeof fetch;
		expect(await make(down).suggest(suggestion)).toBe('failed');
	});

	it('cuts the text at 500 characters', async () => {
		let sent = '';
		const spy = (async (_url: URL, init: RequestInit) => {
			sent = (JSON.parse(String(init.body)) as { text: string }).text;
			return new Response('{}', { status: 201 });
		}) as unknown as typeof fetch;
		await make(spy).suggest(suggestion);
		expect(sent).toHaveLength(500);
	});
});
