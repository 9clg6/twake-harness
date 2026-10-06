import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient, type TestClient } from './helpers/client.js';
import type { ChatRequest, ToolCall } from './helpers/fake-apisix.js';

// The catalog of the contracts service as it is served: absolute paths under /contracts/v1, no
// servers entry, a verb as operationId and the versioned contract as first tag
const CATALOG = {
	openapi: '3.0.3',
	paths: {
		'/contracts/v1/events': {
			get: {
				operationId: 'list_events',
				tags: ['events.list.v1'],
				parameters: [{ name: 'status', in: 'query', required: false, schema: { type: 'string' } }]
			}
		},
		'/contracts/v1/events/{event_id}': {
			get: {
				operationId: 'read_event',
				tags: ['events.read.v1'],
				parameters: [{ name: 'event_id', in: 'path', required: true, schema: { type: 'string' } }]
			}
		},
		'/contracts/v1/calendar/freebusy': {
			get: {
				operationId: 'read_freebusy',
				tags: ['calendar.freebusy.read.v1'],
				parameters: [
					{ name: 'start', in: 'query', required: true, schema: { type: 'string' } },
					{ name: 'end', in: 'query', required: true, schema: { type: 'string' } },
					{ name: 'exclude', in: 'query', required: false, schema: { type: 'string' } }
				]
			}
		}
	}
};

// The same read_event with relative paths, under a server: the other shape OpenAPI allows
function servedUnder(url: string): unknown {
	return {
		openapi: '3.0.3',
		servers: [{ url }],
		paths: {
			'/v1/events/{event_id}': {
				get: {
					operationId: 'read_event',
					tags: ['events.read.v1'],
					parameters: [{ name: 'event_id', in: 'path', required: true, schema: { type: 'string' } }]
				}
			}
		}
	};
}

function call(id: string, name: string, args: unknown): ToolCall {
	return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

// A model that calls the given tools at once, then answers with the statuses it got back
function callingAtOnce(calls: ToolCall[]) {
	return (request: ChatRequest) => {
		const results = request.messages.filter((m) => m.role === 'tool');
		if (results.length === 0) return { toolCalls: calls };
		const statuses = results.map(
			(m) => (JSON.parse(m.content ?? '{}') as { status?: number }).status ?? 0
		);
		return { content: `statuses ${statuses.join(',')}` };
	};
}

async function loadCatalog(h: TestHarness, spec: unknown): Promise<void> {
	h.apisix.contracts.spec = spec;
	for (const app of h.apps) await app.agent.contracts.load();
}

describe('contract calls reach the gateway at the paths the catalog gives', () => {
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
		h.apisix.contracts.handler = () => ({ status: 200, body: { ok: true } });
	});

	it('calls read_event, list_events and read_freebusy at their absolute paths, never doubled', async () => {
		await loadCatalog(h, CATALOG);
		h.apisix.llm.script = callingAtOnce([
			call('c1', 'read_event', { event_id: 'evt-7' }),
			call('c2', 'list_events', { status: 'pending' }),
			call('c3', 'read_freebusy', {
				start: '2026-10-06T14:00:00+02:00',
				end: '2026-10-06T15:00:00+02:00',
				exclude: 'uid-7'
			})
		]);
		const res = await c.post<{ answer: string }>('alice', '/v1/chat', {
			message: 'what is new, and am I free at 14h?'
		});
		expect(res.body.answer).toBe('statuses 200,200,200');
		const received = h.apisix.contracts.calls.map((x) => ({
			method: x.method,
			path: x.path,
			query: x.query
		}));
		expect(received).toEqual([
			{ method: 'GET', path: '/contracts/v1/events/evt-7', query: {} },
			{ method: 'GET', path: '/contracts/v1/events', query: { status: 'pending' } },
			{
				method: 'GET',
				path: '/contracts/v1/calendar/freebusy',
				query: {
					start: '2026-10-06T14:00:00+02:00',
					end: '2026-10-06T15:00:00+02:00',
					exclude: 'uid-7'
				}
			}
		]);
	});

	it('sends a list as one key per item, and a single value as one key', async () => {
		await loadCatalog(h, CATALOG);
		h.apisix.llm.script = callingAtOnce([
			call('c1', 'read_freebusy', {
				start: '2026-10-06T14:00:00+02:00',
				end: '2026-10-06T15:00:00+02:00',
				exclude: ['u1', 'u2']
			}),
			call('c2', 'read_freebusy', {
				start: '2026-10-06T14:00:00+02:00',
				end: '2026-10-06T15:00:00+02:00',
				exclude: 'u3'
			})
		]);
		const res = await c.post<{ answer: string }>('alice', '/v1/chat', { message: 'am I free?' });
		expect(res.body.answer).toBe('statuses 200,200');
		const [several, single] = h.apisix.contracts.calls;
		// Repeated keys, the OpenAPI default for a query array: never "u1,u2" in one value
		expect(several?.query['exclude']).toEqual(['u1', 'u2']);
		expect(single?.query['exclude']).toBe('u3');
	});

	it('calls under the server path when the catalog gives relative paths', async () => {
		await loadCatalog(h, servedUnder('/contracts'));
		h.apisix.llm.script = callingAtOnce([call('c1', 'read_event', { event_id: 'evt-8' })]);
		const res = await c.post<{ answer: string }>('alice', '/v1/chat', { message: 'read it' });
		expect(res.body.answer).toBe('statuses 200');
		expect(h.apisix.contracts.calls.map((x) => x.path)).toEqual(['/contracts/v1/events/evt-8']);
	});

	it('stays on the gateway when the catalog names another host, and says so once', async () => {
		await loadCatalog(h, servedUnder('https://contracts.example.org/contracts'));
		await loadCatalog(h, servedUnder('https://contracts.example.org/contracts'));
		h.apisix.llm.script = callingAtOnce([call('c1', 'read_event', { event_id: 'evt-9' })]);
		const res = await c.post<{ answer: string }>('alice', '/v1/chat', { message: 'read it' });
		expect(res.body.answer).toBe('statuses 200');
		// The call went to the gateway, at the path part of the foreign server
		expect(h.apisix.contracts.calls.map((x) => x.path)).toEqual(['/contracts/v1/events/evt-9']);
		const warnings = h
			.logLines()
			.filter((l) => l['msg'] === 'contracts server is another host, calls stay on the gateway');
		// One warning per replica's catalog, however many times it reloads
		expect(warnings).toHaveLength(h.apps.length);
		expect(warnings[0]?.['server']).toBe('https://contracts.example.org');
	});
});

describe('a gateway that mounts the contracts under a prefix of its own', () => {
	let h: TestHarness;
	let c: TestClient;
	beforeAll(async () => {
		h = await startTestHarness({ env: { CONTRACTS_BASE_PATH: 'gateway-mount' } });
		c = makeClient(h);
		h.apisix.contracts.mount = '/gateway-mount';
	});
	afterAll(async () => {
		await h.close();
	});

	it('prefixes the catalog paths with CONTRACTS_BASE_PATH', async () => {
		await loadCatalog(h, CATALOG);
		h.apisix.contracts.handler = () => ({ status: 200, body: { ok: true } });
		h.apisix.llm.script = callingAtOnce([call('c1', 'read_event', { event_id: 'evt-10' })]);
		const res = await c.post<{ answer: string }>('alice', '/v1/chat', { message: 'read it' });
		expect(res.body.answer).toBe('statuses 200');
		expect(h.apisix.contracts.calls.map((x) => x.path)).toEqual([
			'/gateway-mount/contracts/v1/events/evt-10'
		]);
	});
});
