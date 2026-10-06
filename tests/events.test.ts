import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import type { ChatRequest, ContractCall } from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The catalog of the contracts service as the gateway exposes it: read_event under events.read.v1
const CATALOG = {
	openapi: '3.0.3',
	paths: {
		'/v1/events/{event_id}': {
			get: {
				operationId: 'read_event',
				summary: 'Reads one stored event of the user',
				tags: ['events.read.v1'],
				parameters: [{ name: 'event_id', in: 'path', required: true, schema: { type: 'string' } }]
			}
		}
	}
};

const EVENT = { owner: 'alice@test.local', event_id: 'evt-1', type: 'calendar.invitation' };

describe('an event wakes my assistant', () => {
	let h: MatrixTestHarness;
	let alice: MatrixUser;
	let client: E2eeClient;
	let room: string;
	const assistantId = '@twake-space-assistant-alice:test.local';
	beforeAll(async () => {
		h = await startMatrixHarness({ env: { EVENTS_CLIENT_IDS: 'dispatcher, other-service' } });
		h.apisix.contracts.spec = CATALOG;
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(1);
		h.apisix.contracts.handler = (call: ContractCall) => ({
			status: 200,
			body: {
				id: call.path.split('/').at(-1) ?? '',
				type: 'calendar.invitation',
				subject: 'Budget review moved to Friday'
			}
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
		// The model reads the event with the contract, then tells the owner what it is about
		h.apisix.llm.script = (request: ChatRequest) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool') {
				const data = JSON.parse(last.content ?? '{}') as {
					body?: { type?: string; subject?: string };
				};
				return {
					content: `You received a ${data.body?.type ?? '?'}: ${data.body?.subject ?? '?'}`
				};
			}
			const text = request.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
			const id = /\(id ([^)]+)\)/.exec(text)?.[1] ?? 'unknown';
			return {
				toolCalls: [
					{
						id: 'call_read_event',
						type: 'function',
						function: { name: 'read_event', arguments: JSON.stringify({ event_id: id }) }
					}
				]
			};
		};
	}, 240_000);
	afterAll(async () => {
		if (client !== undefined) await client.stop();
		if (h !== undefined) await h.close();
	});

	function answers(): string[] {
		return client.messages
			.filter((m) => m.roomId === room && m.sender === assistantId && m.body.includes('Budget'))
			.map((m) => m.body);
	}

	it('tells the owner about an event the dispatcher posted, read through the contract', async () => {
		const posted = await h.api.post<{ queued: boolean }>('dispatcher', '/v1/events', EVENT);
		expect(posted.status).toBe(202);
		expect(posted.body.queued).toBe(true);
		const answer = await client.waitForMessage(room, assistantId, (t) => t.includes('Budget'));
		expect(answer).toBe('You received a calendar.invitation: Budget review moved to Friday');
		const call = h.apisix.contracts.calls.find((c) => c.path === '/v1/events/evt-1');
		expect(call?.method).toBe('GET');
		expect(call?.headers['x-twake-on-behalf-of']).toBe('alice@test.local');
		expect(
			h.logLines().some((l) => l['msg'] === 'event queued' && l['client'] === 'dispatcher')
		).toBe(true);
	});

	it('makes one turn of an event delivered twice, even after the first turn is over', async () => {
		const calls = h.apisix.llm.calls.length;
		const again = await h.api.post<{ duplicate: boolean }>('dispatcher', '/v1/events', EVENT);
		expect(again.status).toBe(200);
		expect(again.body.duplicate).toBe(true);
		await sleep(2000);
		expect(h.apisix.llm.calls.length).toBe(calls);
		expect(answers()).toHaveLength(1);
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
			type: 'calendar.invitation'
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
});
