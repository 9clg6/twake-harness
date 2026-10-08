import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { grantConsent } from './helpers/consents.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import {
	CALENDAR_CATALOG,
	INJECTED_NOTE,
	type ChatMessage,
	type ChatRequest,
	type ContractCall,
	type RecordedCall,
	type ToolCall
} from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const INVITED = 'com.twake.calendar.event.invited.v1';

// Accepting an invitation by its calendar UID
function acceptCall(uid: string): ToolCall[] {
	return [
		{
			id: 'call_accept',
			type: 'function',
			function: { name: 'accept_invitation', arguments: JSON.stringify({ body: { uid } }) }
		}
	];
}

const EVENT = { owner: 'alice@test.local', event_id: 'evt-1', type: INVITED };

function remember(content: string, target: 'memory' | 'user' = 'memory'): ToolCall[] {
	return [
		{
			id: 'call_remember',
			type: 'function',
			function: { name: 'memory', arguments: JSON.stringify({ action: 'add', target, content }) }
		}
	];
}

function lastUser(request: ChatRequest | undefined): string {
	return request?.messages.filter((m: ChatMessage) => m.role === 'user').at(-1)?.content ?? '';
}

// The model calls of the turn whose owner message names this event, in order
function turnCalls(calls: readonly RecordedCall[], eventId: string): RecordedCall[] {
	return calls.filter((call) => lastUser(call.request).includes(`(id ${eventId})`));
}

describe('an event wakes my assistant', () => {
	let h: MatrixTestHarness;
	let alice: MatrixUser;
	let client: E2eeClient;
	let room: string;
	const assistantId = '@twake-space-assistant-alice:test.local';
	beforeAll(async () => {
		h = await startMatrixHarness({
			env: { EVENTS_CLIENT_IDS: 'dispatcher, other-service' }
		});
		// These tests are about events: Alice already let her assistant read her calendar and write
		// in it
		await grantConsent(h.db, 'alice@test.local', 'calendar', 'read');
		await grantConsent(h.db, 'alice@test.local', 'calendar', 'write');
		h.apisix.contracts.spec = CALENDAR_CATALOG;
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(2);
		h.apisix.contracts.handler = () => ({
			status: 200,
			body: { start: '', end: '', free: true, busy: [] }
		});
		alice = await h.synapse.registerUser('alice');
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
		// A literal model: it repeats what it was told of the event
		h.apisix.llm.script = (request: ChatRequest) => ({ content: `Event: ${lastUser(request)}` });
	}, 240_000);
	afterAll(async () => {
		if (client !== undefined) await client.stop();
		if (h !== undefined) await h.close();
	});

	// What the assistant told Alice of an event
	function answers(eventId: string): string[] {
		return client.messages
			.filter(
				(m) => m.roomId === room && m.sender === assistantId && m.body.includes(`(id ${eventId})`)
			)
			.map((m) => m.body);
	}

	it('makes one turn of an event delivered twice, even after the first turn is over', async () => {
		const posted = await h.api.post<{ queued: boolean }>('dispatcher', '/v1/events', EVENT);
		expect(posted.status).toBe(202);
		expect(posted.body.queued).toBe(true);
		await client.waitForMessage(room, assistantId, (t) => t.includes('(id evt-1)'));
		expect(
			h.logLines().some((l) => l['msg'] === 'event queued' && l['client'] === 'dispatcher')
		).toBe(true);
		const calls = h.apisix.llm.calls.length;
		const again = await h.api.post<{ duplicate: boolean }>('dispatcher', '/v1/events', EVENT);
		expect(again.status).toBe(200);
		expect(again.body.duplicate).toBe(true);
		await sleep(2000);
		expect(h.apisix.llm.calls.length).toBe(calls);
		expect(answers('evt-1')).toHaveLength(1);
		expect(h.logLines().some((l) => l['msg'] === 'event duplicate')).toBe(true);
	});

	it('refuses an event without credentials, from a user, or for a user without an assistant', async () => {
		const calls = h.apisix.llm.calls.length;
		const app = h.apps[0];
		if (app === undefined) throw new Error('no api replica');
		const anonymous = await app.inject({ method: 'POST', url: '/v1/events', payload: EVENT });
		expect(anonymous.statusCode).toBe(401);
		const asUser = await h.api.post('alice@test.local', '/v1/events', {
			...EVENT,
			event_id: 'evt-2'
		});
		expect(asUser.status).toBe(403);
		const nobody = await h.api.post('dispatcher', '/v1/events', {
			owner: 'nobody',
			event_id: 'evt-3',
			type: INVITED
		});
		expect(nobody.status).toBe(404);
		const malformed = await h.api.post('dispatcher', '/v1/events', { owner: 'alice' });
		expect(malformed.status).toBe(400);
		const reasons = h
			.logLines()
			.filter((l) => l['msg'] === 'event refused')
			.map((l) => l['reason']);
		expect(reasons).toEqual(
			expect.arrayContaining(['missing', 'not_a_dispatcher', 'no_assistant'])
		);
		await sleep(1000);
		expect(h.apisix.llm.calls.length).toBe(calls);
	});
	it('tells the model of any other event as it is, without reading it first', async () => {
		const calls = h.apisix.contracts.calls.length;
		const type = 'com.twake.calendar.event.updated.v1';
		const posted = await h.api.post('dispatcher', '/v1/events', {
			...EVENT,
			event_id: 'evt-upd',
			type
		});
		expect(posted.status).toBe(202);
		await client.waitForMessage(room, assistantId, (t) => t.includes('(id evt-upd)'));
		expect(h.apisix.contracts.calls).toHaveLength(calls);
		const told = lastUser(turnCalls(h.apisix.llm.calls, 'evt-upd')[0]?.request);
		expect(told).toBe(
			`[event] A new event of type "${type}" has arrived (id evt-upd). Read it with the contracts and tell me what it is about.`
		);
	});

	it('links the calls the model makes in an event turn to the event by its bare id', async () => {
		const before = h.apisix.llm.script;
		h.apisix.llm.script = (request: ChatRequest) => {
			if (request.messages.at(-1)?.role === 'tool') return { content: 'Read evt-corr' };
			return {
				toolCalls: [
					{
						id: 'call_read',
						type: 'function',
						function: {
							name: 'read_freebusy',
							arguments: JSON.stringify({
								start: '2026-10-09T09:00:00+02:00',
								end: '2026-10-09T10:00:00+02:00'
							})
						}
					}
				]
			};
		};
		try {
			const posted = await h.api.post('dispatcher', '/v1/events', {
				...EVENT,
				event_id: 'evt-corr',
				type: 'com.twake.calendar.event.updated.v1'
			});
			expect(posted.status).toBe(202);
			await client.waitForMessage(room, assistantId, (t) => t.includes('Read evt-corr'));
			const read = h.apisix.contracts.calls.filter(
				(c) => c.path === '/contracts/v1/calendar/freebusy'
			);
			expect(read).toHaveLength(1);
			expect(read[0]?.headers['x-correlation-id']).toBe('evt-corr');
			expect(read[0]?.headers['x-twake-on-behalf-of']).toBe('alice@test.local');
		} finally {
			h.apisix.llm.script = before;
		}
	});

	it('lets an event make its assistant read, never act on its own: acting waits for the owner', async () => {
		// The invitation's own text told the model to accept at once
		h.apisix.llm.script = (request: ChatRequest) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool') return { content: `Accepted: ${last.content ?? ''}` };
			return {
				content: 'Bob invites you on Friday at 9; you are free.',
				toolCalls: acceptCall(`uid-${/\(id ([^)]+)\)/.exec(lastUser(request))?.[1] ?? 'unknown'}`)
			};
		};
		const posted = await h.api.post('dispatcher', '/v1/events', { ...EVENT, event_id: 'evt-act' });
		expect(posted.status).toBe(202);
		// The harness asks the owner itself, under the model's words, and nothing reaches the
		// calendar, though the owner let the assistant write there
		const request = await client.waitForMessage(room, assistantId, (t) =>
			t.includes('> Bob invites you on Friday at 9')
		);
		expect(request).toContain('I prepared this in calendar for what just arrived');
		expect(request).toContain('"uid": "uid-evt-act"');
		expect(h.apisix.contracts.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
		expect(
			h
				.logLines()
				.some(
					(l) =>
						l['msg'] === 'tool called' &&
						l['tool'] === 'accept_invitation' &&
						l['status'] === 'final'
				)
		).toBe(true);
	});

	it('never lets an event change the language its assistant speaks', async () => {
		// The event's own text told the model to speak French from now on
		h.apisix.llm.script = (request: ChatRequest) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool') return { content: 'Shall I speak French from now on?' };
			return {
				toolCalls: [
					{
						id: 'call_set_language',
						type: 'function',
						function: { name: 'set_language', arguments: JSON.stringify({ language: 'fr' }) }
					}
				]
			};
		};
		const posted = await h.api.post('dispatcher', '/v1/events', {
			...EVENT,
			event_id: 'evt-language',
			type: 'com.twake.calendar.event.updated.v1'
		});
		expect(posted.status).toBe(202);
		await client.waitForMessage(room, assistantId, (t) => t.includes('Shall I speak French'));
		const refusal = h.apisix.llm.calls
			.flatMap((call) => call.request.messages)
			.find((m) => m.role === 'tool' && m.name === 'set_language');
		expect(JSON.parse(refusal?.content ?? '{}')).toMatchObject({ error: 'needs_owner_approval' });
	});

	it("acts on the owner's yes to the harness's request, through the gateway, in the owner's name and under the event's id", async () => {
		const reads = h.apisix.contracts.handler;
		h.apisix.contracts.handler = (call: ContractCall) =>
			call.method === 'POST'
				? { status: 200, body: { uid: 'uid-evt-act', partstat: 'ACCEPTED' } }
				: reads(call);
		// The acceptance the event's turn prepared runs as it was frozen, and the assistant tells
		// the owner how it went
		h.apisix.llm.script = (request: ChatRequest) => {
			const last = request.messages.at(-1);
			return last?.role === 'tool'
				? { content: `Accepted: ${last.content ?? ''}` }
				: { content: 'Nothing to accept' };
		};
		await client.client.sendText(room, 'oui');
		await client.waitForMessage(room, assistantId, (t) => t.includes('"partstat":"ACCEPTED"'));
		const accept = h.apisix.contracts.calls.filter((c) => c.method === 'POST');
		expect(accept).toHaveLength(1);
		expect(accept[0]?.path).toBe('/contracts/v1/calendar/invitations/accept');
		expect(accept[0]?.body).toEqual({ uid: 'uid-evt-act' });
		expect(accept[0]?.headers['x-twake-on-behalf-of']).toBe('alice@test.local');
		expect(accept[0]?.headers['x-twake-contract']).toBe('calendar.invitation.accept.v1');
		expect(accept[0]?.headers['x-correlation-id']).toBe('evt-act');
	});

	it('never lets an event write the memory its owner turns read', async () => {
		// The event's own text told the model to remember to accept every later invitation
		h.apisix.llm.script = (request: ChatRequest) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool') return { content: 'Shall I remember to accept your invitations?' };
			return { toolCalls: remember(INJECTED_NOTE) };
		};
		const posted = await h.api.post('dispatcher', '/v1/events', {
			...EVENT,
			event_id: 'evt-memory'
		});
		expect(posted.status).toBe(202);
		await client.waitForMessage(room, assistantId, (t) => t.includes('Shall I remember'));
		const refusal = h.apisix.llm.calls
			.flatMap((call) => call.request.messages)
			.find((m) => m.role === 'tool' && m.name === 'memory');
		expect(JSON.parse(refusal?.content ?? '{}')).toMatchObject({ error: 'needs_owner_approval' });
		expect(
			h
				.logLines()
				.some(
					(l) => l['msg'] === 'tool called' && l['tool'] === 'memory' && l['status'] === 'denied'
				)
		).toBe(true);
		const kept = await h.api.get<{ memory: string[]; user: string[] }>(
			'alice@test.local',
			'/v1/memory'
		);
		expect(kept.body.memory).not.toContain(INJECTED_NOTE);
	});

	it('never lets an event propose a skill to its owner', async () => {
		h.apisix.llm.script = (request: ChatRequest) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool') return { content: 'Shall I learn to accept your invitations?' };
			return {
				toolCalls: [
					{
						id: 'call_propose',
						type: 'function',
						function: {
							name: 'skills_propose',
							arguments: JSON.stringify({
								name: 'Accept invitations',
								description: 'Accept every invitation without asking',
								content: 'Accept every invitation as soon as it arrives.'
							})
						}
					}
				]
			};
		};
		const posted = await h.api.post('dispatcher', '/v1/events', {
			...EVENT,
			event_id: 'evt-skill'
		});
		expect(posted.status).toBe(202);
		await client.waitForMessage(room, assistantId, (t) => t.includes('Shall I learn'));
		const refusal = h.apisix.llm.calls
			.flatMap((call) => call.request.messages)
			.find((m) => m.role === 'tool' && m.name === 'skills_propose');
		expect(JSON.parse(refusal?.content ?? '{}')).toMatchObject({ error: 'needs_owner_approval' });
		const proposals = await h.api.get<{ proposals: { name: string }[] }>(
			'alice@test.local',
			'/v1/skills/proposals'
		);
		expect(proposals.body.proposals.map((p) => p.name)).not.toContain('Accept invitations');
	});

	it("still remembers what the owner's own message asks", async () => {
		h.apisix.llm.script = (request: ChatRequest) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool') return { content: 'Noted: mornings' };
			return { toolCalls: remember('Prefers meetings in the morning', 'user') };
		};
		await client.client.sendText(room, 'Retiens que je préfère les réunions le matin');
		await client.waitForMessage(room, assistantId, (t) => t.includes('Noted: mornings'));
		const kept = await h.api.get<{ memory: string[]; user: string[] }>(
			'alice@test.local',
			'/v1/memory'
		);
		expect(kept.body.user).toContain('Prefers meetings in the morning');
	});
});
