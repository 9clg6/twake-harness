import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dateIn } from '../src/agent/clock.js';
import { withPrincipal } from '../src/db/client.js';
import { grantConsent } from './helpers/consents.js';
import {
	MEETING_CATALOG,
	toolsOf,
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

const LISTENER = '@twake-assistant:test.local';
const ENCRYPTION = {
	type: 'm.room.encryption',
	state_key: '',
	content: { algorithm: 'm.megolm.v1.aes-sha2' }
};

// The model, as a literal one: in a listened room it names a day and a time with the harness's one
// tool; in a channel it prepares a meeting with the other person. The suite never reads its words.
let proposals = 0;
function dayFromMoment(system: string, offsetDays: number): string {
	const iso = /ISO 8601: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})/.exec(system)?.[1];
	const base = iso === undefined ? new Date() : new Date(iso);
	return dateIn(new Date(base.getTime() + offsetDays * 86_400_000), 'Europe/Paris');
}
const proposeMonday = (request: ChatRequest): ScriptedReply => {
	const system = request.messages[0]?.content ?? '';
	const owner = /whose address is (\S+?)\.\s/.exec(system)?.[1] ?? '';
	if (request.messages.at(-1)?.role === 'tool') return { content: 'NONE' };
	proposals += 1;
	if (toolsOf(request).includes('propose_meeting')) {
		return {
			content: 'Vous avez un créneau.',
			toolCalls: [
				{
					id: `call_${proposals}`,
					type: 'function',
					function: {
						name: 'propose_meeting',
						arguments: JSON.stringify({
							day: dayFromMoment(system, 3),
							time: '10:00',
							duration: 30,
							title: 'Point lundi'
						})
					}
				}
			]
		};
	}
	const other = (system.match(/[\w.-]+@test\.local/g) ?? []).find((p) => p !== owner) ?? '';
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
							start: '2026-10-12T09:30:00+02:00',
							end: '2026-10-12T09:45:00+02:00',
							attendees: [other]
						}
					})
				}
			}
		]
	};
};

describe('an assistant its owner invites into a room in the clear', () => {
	let h: MatrixTestHarness;
	let space: FakeSpace;

	interface ClearRoom {
		readonly owner: MatrixUser;
		readonly others: MatrixUser[];
		readonly room: string;
		readonly assistant: string;
		// The rows that name the room among those the assistant reads
		listened(): Promise<number>;
		// What the assistant wrote in the room, as its owner reads it
		written(): Promise<unknown[]>;
	}

	const say = (user: MatrixUser, room: string, text: string): Promise<string> =>
		h.synapse.sendText(user, room, text);
	const isJoined = async (viewer: MatrixUser, room: string, userId: string): Promise<boolean> =>
		(await h.synapse.joinedMembers(viewer, room)).includes(userId);
	const invite = (inviter: MatrixUser, room: string, userId: string): Promise<unknown> =>
		h.synapse.request(
			inviter,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`,
			{ user_id: userId }
		);
	const stateOf = (user: MatrixUser, room: string, type: string, key: string): Promise<unknown> =>
		h.synapse.request(
			user,
			'GET',
			`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/${type}/${encodeURIComponent(key)}`
		);
	const membership = async (user: MatrixUser, room: string, userId: string): Promise<string> =>
		String(
			((await stateOf(user, room, 'm.room.member', userId)) as { body: Record<string, unknown> })
				.body['membership']
		);
	// Polled until the harness handled the invite: joined, or left again
	const settled = (viewer: MatrixUser, room: string, userId: string): Promise<boolean> =>
		until(async () => {
			const state = await membership(viewer, room, userId);
			return state === 'join' ? true : state === 'leave' ? false : null;
		});
	// The owner invites their assistant: whether it is in the room once the harness has decided
	async function inviteAssistant(c: ClearRoom): Promise<boolean> {
		const from = h.logLines().length;
		await invite(c.owner, c.room, c.assistant);
		await until(() =>
			h
				.logLines()
				.slice(from)
				.find(
					(line) =>
						line['roomId'] === c.room &&
						['assistant listens for its owner', 'assistant declined an invite'].includes(
							String(line['msg'])
						)
				)
		);
		await until(async () =>
			(await membership(c.owner, c.room, c.assistant)) !== 'invite' ? true : null
		);
		return isJoined(c.owner, c.room, c.assistant);
	}

	async function becomeAssistantOwner(localpart: string): Promise<MatrixUser> {
		const user = await h.synapse.registerUser(localpart);
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

	// A room in the clear of the owner and `count` other people, without the listener; the owner's
	// assistant not invited yet; the first `withAssistant` of the others have an assistant of their own
	async function clearRoom(count: number, withAssistant = 0): Promise<ClearRoom> {
		const tag = Math.random().toString(36).slice(2, 7);
		const owner = await becomeAssistantOwner(`o${tag}`);
		const others: MatrixUser[] = [];
		for (let i = 0; i < count; i += 1) {
			const localpart = `p${i}${tag}`;
			others.push(
				i < withAssistant
					? await becomeAssistantOwner(localpart)
					: await h.synapse.registerUser(localpart)
			);
		}
		const created = await h.synapse.request(owner, 'POST', '/_matrix/client/v3/createRoom', {
			preset: 'private_chat',
			name: 'in the clear',
			invite: others.map((user) => user.userId),
			// As Twake Chat opens a room: every member may answer a request
			power_level_content_override: { events: { 'app.twake.chat.assistant_consent': 0 } }
		});
		const room = created.body['room_id'] as string;
		for (const other of others) await h.synapse.joinRoom(other, room);
		const principal = `o${tag}@test.local`;
		const rows = await withPrincipal(
			h.db,
			{ id: principal },
			(tx) => tx.sql<{ user_id: string }[]>`
				select user_id from assistants where owner = ${principal}`
		);
		const assistant = rows[0]?.user_id ?? '';
		return {
			owner,
			others,
			room,
			assistant,
			listened: async () =>
				(await h.db.sql`select 1 from assistant_listened_rooms where room_id = ${room}`).length,
			written: async () => {
				const page = await h.synapse.request(
					owner,
					'GET',
					`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/messages?dir=b&limit=100`
				);
				return (page.body['chunk'] as { sender: string; type: string }[]).filter(
					(event) => event.sender === assistant && event.type !== 'm.room.member'
				);
			}
		};
	}

	const spaceCallsOf = (room: string, since: number) =>
		space.calls.slice(since).filter((call) => call.body['matrixRoomId'] === room);

	beforeAll(async () => {
		space = await startFakeSpace();
		h = await startMatrixHarness({
			env: {
				SUGGESTIONS_ENABLED: 'true',
				SPACE_API_URL: space.url,
				SPACE_API_TOKEN: 'tws_secret',
				ASSISTANT_TIMEZONE: 'Europe/Paris'
			}
		});
		h.apisix.contracts.spec = MEETING_CATALOG;
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(6);
		h.apisix.llm.script = proposeMonday;
		// The owner's calendar, free at the asked time and nowhere else
		h.apisix.contracts.handler = (call: ContractCall) => ({
			status: 200,
			body: call.path.endsWith('/freebusy')
				? { start: '', end: '', free: true, busy: [] }
				: call.path.endsWith('/availability/slots')
					? { slots: [] }
					: call.method === 'POST'
						? { uid: 'm-e1' }
						: { ok: true }
		});
	}, 300_000);
	afterAll(async () => {
		if (h !== undefined) await h.close();
		if (space !== undefined) await space.close();
	});

	it('stays in a group, reads it for its owner alone, writes nothing, and leaves once its owner goes', async () => {
		const c = await clearRoom(2);
		const [first, second] = c.others as [MatrixUser, MatrixUser];
		expect(await inviteAssistant(c)).toBe(true);
		await until(async () => ((await c.listened()) === 1 ? true : null));

		// What the others say is read for the owner, who alone is proposed something
		const before = space.calls.length;
		await say(first, c.room, 'On se voit quand ?');
		await say(second, c.room, 'ok on parle lundi à 10h');
		const made = await until(() => spaceCallsOf(c.room, before)[0]);
		expect(made.body['matrixUserId']).toBe(c.owner.userId);
		await sleep(3000);
		expect(spaceCallsOf(c.room, before)).toHaveLength(1);
		expect(await c.written()).toHaveLength(0);

		// Its owner gone: it goes too, without a word, and the room is forgotten
		await h.synapse.request(
			c.owner,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(c.room)}/leave`,
			{}
		);
		await until(async () => ((await c.listened()) === 0 ? true : null));
		await until(async () =>
			(await membership(first, c.room, c.assistant)) === 'leave' ? true : null
		);
	});

	it('defers to the listener where it reads the room, so that each person is proposed to once', async () => {
		const c = await clearRoom(2, 1);
		const [first] = c.others as [MatrixUser, MatrixUser];
		await invite(c.owner, c.room, LISTENER);
		expect(await settled(c.owner, c.room, LISTENER)).toBe(true);
		expect(await inviteAssistant(c)).toBe(true);
		await until(async () => ((await c.listened()) === 1 ? true : null));

		// The channel's pair: the one who wrote and the one who wrote before, the owner once
		const before = space.calls.length;
		await say(first, c.room, 'On se voit quand ?');
		const eventId = await say(c.owner, c.room, 'ok on parle lundi à 10h');
		await until(() => (spaceCallsOf(c.room, before).length >= 2 ? true : null));
		await sleep(3000);
		expect(
			spaceCallsOf(c.room, before)
				.map((call) => call.body['matrixUserId'])
				.sort()
		).toEqual([c.owner.userId, first.userId].sort());
		expect(
			h
				.logLines()
				.filter((line) => line['msg'] === 'suggestions queued' && line['eventId'] === eventId)
		).toHaveLength(1);
		expect(await c.written()).toHaveLength(0);

		// The listener removed, the room is the assistant's to read for its owner again
		await h.synapse.request(
			c.owner,
			'POST',
			`/_matrix/client/v3/rooms/${encodeURIComponent(c.room)}/kick`,
			{ user_id: LISTENER }
		);
		await until(async () =>
			(await membership(c.owner, c.room, LISTENER)) === 'leave' ? true : null
		);
		const again = await say(first, c.room, 'ok on parle mardi à 10h');
		const queued = await until(() =>
			h.logLines().find((line) => line['msg'] === 'suggestions queued' && line['eventId'] === again)
		);
		expect(queued['candidates']).toBe(1);
		expect(await c.listened()).toBe(1);
	});

	it('leaves without a word once the room turns encrypted, as everyone would have to say yes', async () => {
		const c = await clearRoom(2);
		expect(await inviteAssistant(c)).toBe(true);
		await until(async () => ((await c.listened()) === 1 ? true : null));
		await h.synapse.request(
			c.owner,
			'PUT',
			`/_matrix/client/v3/rooms/${encodeURIComponent(c.room)}/state/m.room.encryption`,
			ENCRYPTION.content
		);
		await until(async () => ((await c.listened()) === 0 ? true : null));
		await until(async () =>
			(await membership(c.owner, c.room, c.assistant)) === 'leave' ? true : null
		);
		expect(await c.written()).toHaveLength(0);
	});

	it('still waits for the yes of the other person in a conversation of two, in the clear', async () => {
		const c = await clearRoom(1);
		const [other] = c.others as [MatrixUser];
		// Not asked: it leaves at once, without a word
		expect(await inviteAssistant(c)).toBe(false);
		expect(await c.listened()).toBe(0);
		expect(await c.written()).toHaveLength(0);
		// Asked and accepted, as Twake Chat does before it invites: it stays
		await h.synapse.request(
			c.owner,
			'PUT',
			`/_matrix/client/v3/rooms/${encodeURIComponent(c.room)}/state/app.twake.chat.assistant_request/${encodeURIComponent(c.owner.userId)}`,
			{ assistant_id: c.assistant, requested: true, ts: Date.now() }
		);
		await h.synapse.request(
			other,
			'PUT',
			`/_matrix/client/v3/rooms/${encodeURIComponent(c.room)}/state/app.twake.chat.assistant_consent/${encodeURIComponent(other.userId)}`,
			{ assistant_id: c.assistant, accepted: true, ts: Date.now() }
		);
		expect(await inviteAssistant(c)).toBe(true);
		await until(async () => ((await c.listened()) === 1 ? true : null));
		expect(await isJoined(c.owner, c.room, c.assistant)).toBe(true);
	});
});
