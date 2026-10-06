import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withPrincipal, type Db } from '../src/db/client.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient, type TestClient } from './helpers/client.js';
import { readCatalog, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import type { ChatRequest, ScriptedReply, ToolCall } from './helpers/fake-apisix.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const DOMAINS = ['mail', 'drive', 'notes', 'tasks', 'wiki', 'boards', 'contacts', 'forms'];

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

// A pending call as the API shows it, frozen in a turn through the API in a session
function pendingInTurn(domain: string, sessionId: string): Record<string, unknown> {
	return {
		id: expect.stringMatching(/^[0-9a-f-]{36}$/),
		channel: 'api_chat',
		session_id: sessionId,
		tool: `search_${domain}`,
		contract: `${domain}.items.read.v1`,
		domain,
		level: 'read',
		reasons: ['consent'],
		request: question(domain),
		created_at: expect.any(String),
		expires_at: expect.any(String)
	};
}

// What the harness keeps of one of an owner's pending calls: the arguments it would send, and the
// question asked about it
async function keptOf(
	db: Db,
	owner: string,
	id: string
): Promise<{ arguments: unknown; request: unknown }> {
	const rows = await withPrincipal(
		db,
		{ id: owner },
		(tx) =>
			tx.sql<{ arguments: unknown; request_text: unknown }[]>`
			select arguments, request_text from pending_calls where id = ${id}`
	);
	return { arguments: rows[0]?.arguments ?? null, request: rows[0]?.request_text ?? null };
}

// What the api replicas count, as a dashboard sums them
async function countedLines(h: TestHarness): Promise<string[]> {
	const lines: string[] = [];
	for (const app of h.apps) {
		lines.push(...(await app.inject({ method: 'GET', url: '/metrics' })).body.split('\n'));
	}
	return lines;
}

// What a client reads of a turn through the API that stopped on the harness's question
interface WaitingTurn {
	readonly session_id: string;
	readonly pending_call: { readonly id: string };
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
	it('returns the pending call of a turn through the API, and the gateway receives nothing', async () => {
		const turn = await h.app.inject({
			method: 'POST',
			url: '/v1/chat',
			headers: {
				authorization: `Bearer ${await h.issuer.mint({ sub: 'alice' })}`,
				'x-request-id': 'corr-chat-tasks'
			},
			payload: { message: 'Find the budget in my tasks' }
		});
		expect(turn.statusCode).toBe(200);
		const body = turn.json<{
			session_id: string;
			pending_call: { created_at: string; expires_at: string };
		}>();
		expect(body).toEqual({
			session_id: expect.any(String),
			answer: question('tasks'),
			model: 'qwen3.8',
			pending_call: pendingInTurn('tasks', body.session_id)
		});
		// It waits for a day, as a question in the room does
		expect(
			Date.parse(body.pending_call.expires_at) - Date.parse(body.pending_call.created_at)
		).toBe(86_400_000);
		expect(h.apisix.contracts.calls).toHaveLength(0);
	});
	it("lists what waits for my answer, and nothing of anyone else's", async () => {
		const turn = await c.post<{ session_id: string; pending_call: { id: string } }>(
			'alice',
			'/v1/chat',
			{ message: 'Find the budget in my wiki' }
		);
		const waiting = await c.get<{ pending_calls: { id: string }[] }>('alice', '/v1/pending-calls');
		expect(waiting.status).toBe(200);
		expect(waiting.body.pending_calls).toContainEqual(pendingInTurn('wiki', turn.body.session_id));
		expect(await c.get('bob', '/v1/pending-calls')).toEqual({
			status: 200,
			body: { pending_calls: [] }
		});
	});
	it('runs the call of a turn through the API once I approve it, and the conversation goes on', async () => {
		const turn = await h.app.inject({
			method: 'POST',
			url: '/v1/chat',
			headers: {
				authorization: `Bearer ${await h.issuer.mint({ sub: 'alice' })}`,
				'x-request-id': 'corr-chat-boards'
			},
			payload: { message: 'Find the budget in my boards' }
		});
		const { session_id: sessionId, pending_call: pending } = turn.json<WaitingTurn>();
		// Nobody else answers for me
		expect((await c.post('bob', `/v1/pending-calls/${pending.id}/approve`, {})).status).toBe(404);
		expect(h.apisix.contracts.calls).toHaveLength(0);
		expect(await c.post('alice', `/v1/pending-calls/${pending.id}/approve`, {})).toEqual({
			status: 200,
			body: {
				session_id: sessionId,
				answer: 'Told: {"status":200,"body":{"found":"/contracts/v1/boards/items"}}',
				model: 'qwen3.8'
			}
		});
		// The call ran as it was frozen, in my name, linked to the turn that froze it
		expect(h.apisix.contracts.calls).toHaveLength(1);
		const ran = h.apisix.contracts.calls[0];
		expect(ran?.query).toEqual({ q: 'budget' });
		expect(ran?.headers['x-twake-on-behalf-of']).toBe('alice');
		expect(ran?.headers['x-correlation-id']).toBe('corr-chat-boards');
		// A second answer finds it decided, and runs nothing
		expect(await c.post('alice', `/v1/pending-calls/${pending.id}/approve`, {})).toEqual({
			status: 409,
			body: { error: 'pending call closed', state: 'decided' }
		});
		expect(h.apisix.contracts.calls).toHaveLength(1);
		// My yes allowed the application, through the API
		const consents = await c.get<{ consents: { domain: string }[] }>('alice', '/v1/consents');
		expect(consents.body.consents.find((consent) => consent.domain === 'boards')).toMatchObject({
			level: 'read',
			granted_by: 'api'
		});
		// An operator sees one answer through the API, which decided the call
		expect(await countedLines(h)).toContain(
			'harness_consent_answers_total{domain="boards",level="read",reason="consent",answer="yes",via="api",outcome="decided"} 1'
		);
	});
	it('returns the pending call of a direct tool call, and runs the call once I approve it', async () => {
		const frozen = await h.app.inject({
			method: 'POST',
			url: '/v1/tool',
			headers: {
				authorization: `Bearer ${await h.issuer.mint({ sub: 'alice' })}`,
				'x-request-id': 'corr-tool-contacts'
			},
			payload: { tool: 'search_contacts', arguments: { q: 'Paul' } }
		});
		expect(frozen.statusCode).toBe(202);
		const { pending_call: pending } = frozen.json<{ pending_call: { id: string } }>();
		expect(pending).toEqual({
			...pendingInTurn('contacts', ''),
			channel: 'api_tool',
			session_id: null
		});
		expect(h.apisix.contracts.calls).toHaveLength(0);
		// My yes runs the call as it was frozen, and answers as the tool call would have
		expect(await c.post('alice', `/v1/pending-calls/${pending.id}/approve`, {})).toEqual({
			status: 200,
			body: { status: 200, body: { found: '/contracts/v1/contacts/items' } }
		});
		expect(h.apisix.contracts.calls).toHaveLength(1);
		expect(h.apisix.contracts.calls[0]?.query).toEqual({ q: 'Paul' });
		expect(h.apisix.contracts.calls[0]?.headers['x-correlation-id']).toBe('corr-tool-contacts');
		expect(await keptOf(h.db, 'alice', pending.id)).toEqual({ arguments: null, request: null });
		expect(await c.post('alice', `/v1/pending-calls/${pending.id}/approve`, {})).toEqual({
			status: 409,
			body: { error: 'pending call closed', state: 'decided' }
		});
		expect(h.apisix.contracts.calls).toHaveLength(1);
	});
	it('keeps the rights to call contracts above my answer through the API', async () => {
		const frozen = await c.tool<{ pending_call: { id: string } }>('carol', 'search_forms', {
			q: 'leave'
		});
		expect(frozen.status).toBe(202);
		// An administrator cuts Carol's assistant off from the contracts before she answers
		await h.db.sql.begin(async (sql) => {
			await sql`select set_config('app.principal', 'carol', true)`;
			await sql`update principals set actions = ${sql.json(['chat'])} where id = 'carol'`;
		});
		expect(
			await c.post('carol', `/v1/pending-calls/${frozen.body.pending_call.id}/approve`, {})
		).toEqual({ status: 403, body: { error: 'forbidden' } });
		expect(h.apisix.contracts.calls).toHaveLength(0);
	});

	it('drops a pending call when I refuse it, and keeps nothing of what it would have sent', async () => {
		const turn = await c.post<WaitingTurn>('alice', '/v1/chat', {
			message: 'Find the budget in my notes'
		});
		const { id } = turn.body.pending_call;
		expect((await c.post('bob', `/v1/pending-calls/${id}/refuse`, {})).status).toBe(404);
		expect(await c.post('alice', `/v1/pending-calls/${id}/refuse`, {})).toEqual({
			status: 200,
			body: { id, status: 'refused' }
		});
		expect(await c.post('alice', `/v1/pending-calls/${id}/approve`, {})).toEqual({
			status: 409,
			body: { error: 'pending call closed', state: 'decided' }
		});
		expect(h.apisix.contracts.calls).toHaveLength(0);
		const waiting = await c.get<{ pending_calls: { id: string }[] }>('alice', '/v1/pending-calls');
		expect(waiting.body.pending_calls.map((call) => call.id)).not.toContain(id);
		expect(await keptOf(h.db, 'alice', id)).toEqual({ arguments: null, request: null });
		expect(await countedLines(h)).toContain(
			'harness_consent_answers_total{domain="notes",level="read",reason="consent",answer="no",via="api",outcome="decided"} 1'
		);
	});
});

describe('my answer through the API is admitted like any turn', () => {
	let h: TestHarness;
	let c: TestClient;
	beforeAll(async () => {
		// One turn a minute: the question takes it, so the answer comes over the limit
		h = await startTestHarness({ env: { ADMISSION_USER_PER_MINUTE: '1' } });
		c = makeClient(h);
		h.apisix.contracts.spec = readCatalog(['mail']);
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(1);
		h.apisix.llm.script = searchingModel;
	});
	afterAll(async () => {
		if (h !== undefined) await h.close();
	});

	it('tells me it is busy when my answer comes over my limit, and keeps the call waiting', async () => {
		const turn = await c.post<WaitingTurn>('alice', '/v1/chat', {
			message: 'Find the budget in my mail'
		});
		expect(turn.status).toBe(200);
		const { id } = turn.body.pending_call;
		expect(await c.post('alice', `/v1/pending-calls/${id}/approve`, {})).toEqual({
			status: 429,
			body: { error: 'busy', reason: 'user_rate' }
		});
		expect(h.apisix.contracts.calls).toHaveLength(0);
		const waiting = await c.get<{ pending_calls: { id: string }[] }>('alice', '/v1/pending-calls');
		expect(waiting.body.pending_calls.map((call) => call.id)).toEqual([id]);
	});
});

describe('my answer through the API to a question in my room', () => {
	let r: ConsentRoom;
	beforeAll(async () => {
		r = await startConsentRoom({ ADMISSION_USER_PER_MINUTE: '100' });
		r.h.apisix.contracts.spec = readCatalog(DOMAINS);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(DOMAINS.length);
		r.h.apisix.llm.script = searchingModel;
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});
	beforeEach(() => {
		r.h.apisix.contracts.calls.length = 0;
		r.h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
	});

	// I ask in my room for something the assistant needs an application for, and the API shows
	// the call that waits: resolves to its id, my message's event and the question's event
	async function askInRoom(
		text: string
	): Promise<{ id: string; messageId: string; questionId: string }> {
		const seen = r.questions().length;
		const messageId = await r.client.sendText(r.room, text);
		const questionId = await r.nextQuestion(seen);
		const waiting = await r.h.api.get<{
			pending_calls: { id: string; channel: string; request: string }[];
		}>('alice@test.local', '/v1/pending-calls');
		const call = waiting.body.pending_calls.at(-1);
		if (call === undefined) throw new Error('nothing waits for my answer');
		// The API shows the question as my room does
		expect(call.channel).toBe('room');
		expect(call.request).toBe(r.questions().at(-1)?.body);
		return { id: call.id, messageId, questionId };
	}

	it('resumes a call asked in my room when I approve it through the API, as a ✅ would', async () => {
		const { id, messageId } = await askInRoom('Find the budget in my mail');
		const told = r.saying('Told:').length;
		expect(await r.h.api.post('alice@test.local', `/v1/pending-calls/${id}/approve`, {})).toEqual({
			status: 202,
			body: { id, status: 'approved' }
		});
		expect(await r.nextSaying('Told:', told)).toBe(
			'Told: {"status":200,"body":{"found":"/contracts/v1/mail/items"}}'
		);
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
		expect(r.h.apisix.contracts.calls[0]?.headers['x-correlation-id']).toBe(messageId);
		const consents = await r.h.api.get<{ consents: { domain: string }[] }>(
			'alice@test.local',
			'/v1/consents'
		);
		expect(consents.body.consents.find((consent) => consent.domain === 'mail')).toMatchObject({
			level: 'read',
			granted_by: 'api'
		});
	});

	it('drops a call asked in my room when I refuse it through the API, as a ❌ would', async () => {
		const { id } = await askInRoom('Find the budget in my drive');
		const acknowledged = r.saying('All right').length;
		const modelCalls = r.h.apisix.llm.calls.length;
		expect(await r.h.api.post('alice@test.local', `/v1/pending-calls/${id}/refuse`, {})).toEqual({
			status: 200,
			body: { id, status: 'refused' }
		});
		expect(await r.nextSaying('All right', acknowledged)).toBe('All right, I will not do it.');
		expect(r.h.apisix.llm.calls).toHaveLength(modelCalls);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it('runs a call once when I answer it in my room, then through the API', async () => {
		const { id, questionId } = await askInRoom('Find the budget in my tasks');
		const told = r.saying('Told:').length;
		await r.client.react(r.room, questionId, '✅');
		await r.nextSaying('Told:', told);
		for (const answer of ['approve', 'refuse']) {
			expect(
				await r.h.api.post('alice@test.local', `/v1/pending-calls/${id}/${answer}`, {})
			).toEqual({ status: 409, body: { error: 'pending call closed', state: 'decided' } });
		}
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
	});

	it('runs a call once when I answer it through the API, then in my room', async () => {
		const { id, questionId } = await askInRoom('Find the budget in my wiki');
		const told = r.saying('Told:').length;
		expect(
			(await r.h.api.post('alice@test.local', `/v1/pending-calls/${id}/approve`, {})).status
		).toBe(202);
		await r.nextSaying('Told:', told);
		await r.client.react(r.room, questionId, '✅');
		// My second answer finds the call decided, and changes nothing
		let closed = false;
		for (let i = 0; i < 120 && !closed; i += 1) {
			closed = r.h
				.logLines()
				.some(
					(l) =>
						l['msg'] === 'answer to a closed request' &&
						l['pendingCallId'] === id &&
						l['state'] === 'decided'
				);
			if (!closed) await sleep(250);
		}
		expect(closed).toBe(true);
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
		expect(r.saying('Told:')).toHaveLength(told + 1);
	});
});
