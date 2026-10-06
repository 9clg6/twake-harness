import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient, type TestClient } from './helpers/client.js';
import { echoScript, type ChatRequest, type ToolCall } from './helpers/fake-apisix.js';

const FRENCH_HINT =
	"Pour retrouver une invitation qui n'est pas dans cette conversation, cherche-la avec list_events, puis lis-la avec read_event avant d'en parler ou d'agir.";
const ENGLISH_HINT =
	'To find an invitation that is not in this conversation, search for it with list_events, then read it with read_event before you speak of it or act on it.';

// The events contracts as the contracts service publishes them
const EVENTS_CATALOG = {
	openapi: '3.1.0',
	paths: {
		'/contracts/v1/events': {
			get: {
				operationId: 'list_events',
				tags: ['events.read.v1'],
				parameters: [{ name: 'status', in: 'query', required: false, schema: { type: 'string' } }]
			}
		},
		'/contracts/v1/events/{event_id}': {
			get: {
				operationId: 'read_event',
				tags: ['events.read.v1'],
				parameters: [{ name: 'event_id', in: 'path', required: true, schema: { type: 'string' } }]
			}
		}
	}
};

function call(id: string, name: string, args: unknown): ToolCall {
	return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

// The system prompt the scripted model received for one chat turn of this user
async function systemPromptOfTurn(h: TestHarness, sub: string, message: string): Promise<string> {
	h.apisix.llm.script = echoScript;
	const before = h.apisix.llm.calls.length;
	const res = await h.app.inject({
		method: 'POST',
		url: '/v1/chat',
		headers: { authorization: `Bearer ${await h.issuer.mint({ sub })}` },
		payload: { message }
	});
	expect(res.statusCode).toBe(200);
	return h.apisix.llm.calls[before]?.request.messages[0]?.content ?? '';
}

describe('my assistant finds an invitation the conversation does not hold', () => {
	describe('in a French deployment', () => {
		let h: TestHarness;
		beforeAll(async () => {
			h = await startTestHarness({ env: { ASSISTANT_LOCALE: 'fr' } });
		});
		afterAll(async () => {
			await h.close();
		});

		it('tells the model, in French, to search with list_events and then read with read_event', async () => {
			const prompt = await systemPromptOfTurn(h, 'alice', "Accepte l'invitation de Paul");
			expect(prompt).toContain(FRENCH_HINT);
			expect(prompt).not.toContain(ENGLISH_HINT);
		});
	});

	describe('in an English deployment', () => {
		let h: TestHarness;
		let c: TestClient;
		beforeAll(async () => {
			h = await startTestHarness();
			c = makeClient(h);
		});
		afterAll(async () => {
			await h.close();
		});
		beforeEach(() => {
			h.apisix.llm.calls.length = 0;
			h.apisix.contracts.calls.length = 0;
		});

		it('tells the model, in English, to search with list_events and then read with read_event', async () => {
			const prompt = await systemPromptOfTurn(h, 'alice', "Accept Paul's invitation");
			expect(prompt).toContain(ENGLISH_HINT);
			expect(prompt).not.toContain(FRENCH_HINT);
		});

		it('lets an owner turn search the events, then read the one it found, at their paths', async () => {
			h.apisix.contracts.spec = EVENTS_CATALOG;
			for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(2);
			h.apisix.contracts.handler = (received) =>
				received.path === '/contracts/v1/events'
					? { status: 200, body: { events: [{ id: 'evt-paul', title: 'Point with Paul' }] } }
					: { status: 200, body: { id: 'evt-paul', title: 'Point with Paul' } };
			// A model that searches first, then reads what the search returned, then answers
			h.apisix.llm.script = (request: ChatRequest) => {
				const results = request.messages.filter((m) => m.role === 'tool');
				if (results.length === 0) return { toolCalls: [call('c1', 'list_events', {})] };
				if (results.length === 1) {
					const listed = JSON.parse(results[0]?.content ?? '{}') as {
						body?: { events?: { id: string }[] };
					};
					const found = listed.body?.events?.[0]?.id ?? 'none';
					return { toolCalls: [call('c2', 'read_event', { event_id: found })] };
				}
				return { content: 'found and read' };
			};
			const res = await c.post<{ answer: string }>('alice', '/v1/chat', {
				message: "Accept Paul's invitation for Thursday"
			});
			expect(res.status).toBe(200);
			expect(res.body.answer).toBe('found and read');
			expect(
				h.apisix.contracts.calls.map((received) => ({
					method: received.method,
					path: received.path,
					owner: received.headers['x-twake-on-behalf-of']
				}))
			).toEqual([
				{ method: 'GET', path: '/contracts/v1/events', owner: 'alice' },
				{ method: 'GET', path: '/contracts/v1/events/evt-paul', owner: 'alice' }
			]);
		});
	});
});
