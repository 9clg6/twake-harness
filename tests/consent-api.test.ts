import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient, type TestClient } from './helpers/client.js';
import { readCatalog } from './helpers/consent-room.js';
import type { ChatRequest, ScriptedReply, ToolCall } from './helpers/fake-apisix.js';

const DOMAINS = ['mail', 'drive', 'notes'];

// The reading of the assistant's own feed of events, which every listing shows as built in
const FEED = { domain: 'events', level: 'read', granted_by: 'built_in', granted_at: null };

function question(domain: string): string {
	return `This is the first time I need to read your data in ${domain}. Do you allow it? Answer with the buttons below, or reply yes or no.`;
}

function call(name: string, args: unknown): ToolCall[] {
	return [
		{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
	];
}

// A literal model: it searches the application its owner names, and tells what the search
// returned
function searchingModel(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	if (last?.role === 'tool') return { content: `Told: ${last.content ?? ''}` };
	const domain = /in my (\w+)/.exec(last?.content ?? '')?.[1] ?? 'mail';
	return { toolCalls: call(`search_${domain}`, { q: 'budget' }) };
}

describe('my consents through the API', () => {
	let h: TestHarness;
	let c: TestClient;
	beforeAll(async () => {
		h = await startTestHarness();
		c = makeClient(h);
		h.apisix.contracts.spec = readCatalog(DOMAINS);
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(DOMAINS.length);
		h.apisix.llm.script = searchingModel;
	});
	afterAll(async () => {
		if (h !== undefined) await h.close();
	});
	beforeEach(() => {
		h.apisix.contracts.calls.length = 0;
		h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
	});

	it('lists, grants and withdraws my consents with my own token, and my assistant follows', async () => {
		expect(await c.get('alice', '/v1/consents')).toEqual({
			status: 200,
			body: { consents: [FEED] }
		});
		const granted = await c.put('alice', '/v1/consents/mail/read', {});
		expect(granted).toEqual({
			status: 201,
			body: { domain: 'mail', level: 'read', granted_by: 'api', granted_at: expect.any(String) }
		});
		expect((await c.put('alice', '/v1/consents/mail/read', {})).status).toBe(200);
		expect((await c.get('alice', '/v1/consents')).body).toEqual({
			consents: [FEED, granted.body]
		});
		// My assistant reads my mail without asking me first
		const read = await c.post<{ answer: string }>('alice', '/v1/chat', {
			message: 'Find the budget in my mail'
		});
		expect(read.body.answer).toBe(
			'Told: {"status":200,"body":{"found":"/contracts/v1/mail/items"}}'
		);
		expect(h.apisix.contracts.calls).toHaveLength(1);
		expect((await c.delete('alice', '/v1/consents/mail/read')).status).toBe(204);
		expect((await c.delete('alice', '/v1/consents/mail/read')).status).toBe(404);
		// and asks me again once I withdrew it
		const asked = await c.post<{ answer: string }>('alice', '/v1/chat', {
			message: 'Find the budget in my mail'
		});
		expect(asked.body.answer).toBe(question('mail'));
		expect(h.apisix.contracts.calls).toHaveLength(1);
	});
	it("keeps my consents out of everyone else's reach", async () => {
		expect((await c.put('alice', '/v1/consents/drive/read', {})).status).toBe(201);
		expect((await c.get('bob', '/v1/consents')).body).toEqual({ consents: [FEED] });
		expect((await c.delete('bob', '/v1/consents/drive/read')).status).toBe(404);
		expect((await c.put('bob', '/v1/consents/notes/read', {})).status).toBe(201);
		const mine = await c.get<{ consents: { domain: string; level: string }[] }>(
			'alice',
			'/v1/consents'
		);
		expect(mine.body.consents.map((consent) => `${consent.domain} ${consent.level}`)).toEqual([
			'drive read',
			'events read'
		]);
		// Without my token, nothing is listed
		const anonymous = await h.app.inject({ method: 'GET', url: '/v1/consents' });
		expect(anonymous.statusCode).toBe(401);
		expect(anonymous.json()).toEqual({ error: 'invalid token' });
	});

	it('shows the feed of events as built in, and grants only what the catalog offers', async () => {
		expect(await c.put('alice', '/v1/consents/events/read', {})).toEqual({
			status: 200,
			body: FEED
		});
		expect(await c.delete('alice', '/v1/consents/events/read')).toEqual({
			status: 409,
			body: { error: 'consent built in' }
		});
		// No application of the catalog is called photos, no mail contract writes, and admin is no
		// level
		for (const path of ['photos/read', 'mail/write', 'mail/admin']) {
			expect(await c.put('alice', `/v1/consents/${path}`, {})).toEqual({
				status: 404,
				body: { error: 'resource unavailable' }
			});
		}
		expect((await c.delete('alice', '/v1/consents/mail/admin')).status).toBe(404);
	});
});
