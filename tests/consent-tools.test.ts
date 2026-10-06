import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient, type TestClient } from './helpers/client.js';
import { call, readCatalog, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { grantConsent } from './helpers/consents.js';
import type { ChatRequest, ScriptedReply, ToolCall } from './helpers/fake-apisix.js';

const DOMAINS = ['mail', 'drive', 'calendar', 'tasks', 'notes'];

// A read contract in each application, and a write in the calendar
const CATALOG = {
	openapi: '3.0.3',
	paths: {
		...(readCatalog(DOMAINS)['paths'] as Record<string, unknown>),
		'/contracts/v1/calendar/events': {
			post: {
				operationId: 'add_calendar_event',
				summary: "Adds an event to the user's calendar",
				tags: ['calendar.events.create.v1'],
				parameters: [{ name: 'title', in: 'query', required: true, schema: { type: 'string' } }]
			}
		}
	}
};

// A literal model: it calls the tool given for each request it knows, and tells the owner what
// the tool returned
function modelTelling(
	requests: Record<string, { readonly tool: string; readonly args: unknown }>
): (request: ChatRequest) => ScriptedReply {
	return (request) => {
		const last = request.messages.at(-1);
		if (last?.role === 'tool') return { content: `Told: ${last.content ?? ''}` };
		const known = last?.role === 'user' ? requests[last.content ?? ''] : undefined;
		return known === undefined
			? { content: 'Heard you' }
			: { toolCalls: call(known.tool, known.args) };
	};
}

describe('I ask my assistant what it may access, and take accesses back', () => {
	let r: ConsentRoom;
	beforeAll(async () => {
		r = await startConsentRoom({
			ADMISSION_USER_PER_MINUTE: '100',
			EVENTS_CLIENT_IDS: 'dispatcher'
		});
		r.h.apisix.contracts.spec = CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(DOMAINS.length + 1);
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});
	beforeEach(() => {
		r.h.apisix.contracts.calls.length = 0;
		r.h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
	});

	// What the assistant told me after my message, as the model above relays a tool's result
	async function told(text: string): Promise<unknown> {
		const seen = r.saying('Told:').length;
		await r.client.sendText(r.room, text);
		return JSON.parse((await r.nextSaying('Told:', seen)).slice('Told: '.length));
	}

	// Lets the assistant read an application, as I do when it first asks
	async function allow(text: string): Promise<void> {
		const seen = r.questions().length;
		await r.client.sendText(r.room, text);
		await r.nextQuestion(seen);
		const found = r.saying('Told:').length;
		await r.client.sendText(r.room, 'yes');
		await r.nextSaying('Told:', found);
	}

	it('tells me what it may access: what I allowed, and its own feed of events', async () => {
		r.h.apisix.llm.script = modelTelling({
			'Find the budget in my mail': { tool: 'search_mail', args: { q: 'budget' } },
			'What may you access?': { tool: 'consents_list', args: {} }
		});
		await allow('Find the budget in my mail');
		expect(await told('What may you access?')).toEqual({
			consents: [
				{ domain: 'events', level: 'read', granted_by: 'built_in', granted_at: null },
				{ domain: 'mail', level: 'read', granted_by: 'chat', granted_at: expect.any(String) }
			]
		});
	});

	it('stops using an application when I tell it to, and asks me again the next time', async () => {
		r.h.apisix.llm.script = modelTelling({
			'Find my plan in my drive': { tool: 'search_drive', args: { q: 'plan' } },
			'Stop using my drive': { tool: 'consents_withdraw', args: { domain: 'drive' } }
		});
		await allow('Find my plan in my drive');
		expect(await told('Stop using my drive')).toEqual({
			domain: 'drive',
			withdrawn: ['read'],
			still_allowed: []
		});
		r.h.apisix.contracts.calls.length = 0;
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Find my plan in my drive');
		await r.nextQuestion(seen);
		expect(r.questions().at(-1)?.body).toBe(
			'This is the first time I need to read your data in drive. Do you allow it? Answer with the buttons below, or reply yes or no.'
		);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it('stops only writing in an application when I tell it to: it asks before its next write there, and keeps reading', async () => {
		r.h.apisix.llm.script = modelTelling({
			'What is in my calendar?': { tool: 'search_calendar', args: { q: 'today' } },
			'Add the budget review to my calendar': {
				tool: 'add_calendar_event',
				args: { title: 'Budget review' }
			},
			'Stop writing in my calendar': {
				tool: 'consents_withdraw',
				args: { domain: 'calendar', level: 'write' }
			}
		});
		// It reads my calendar since I allowed it, and writes there as the pilot's assistants did
		await allow('What is in my calendar?');
		await grantConsent(r.h.db, 'alice@test.local', 'calendar', 'write');
		expect(await told('Stop writing in my calendar')).toEqual({
			domain: 'calendar',
			withdrawn: ['write'],
			still_allowed: ['read']
		});
		r.h.apisix.contracts.calls.length = 0;
		const seen = r.questions().length;
		expect(await told('What is in my calendar?')).toEqual({
			status: 200,
			body: { found: '/contracts/v1/calendar/items' }
		});
		expect(r.questions()).toHaveLength(seen);
		expect(r.h.apisix.contracts.calls.map((c) => c.path)).toEqual(['/contracts/v1/calendar/items']);
		await r.client.sendText(r.room, 'Add the budget review to my calendar');
		await r.nextQuestion(seen);
		expect(r.questions().at(-1)?.body).toBe(
			'This is the first time I need to change your data in calendar. Do you allow it? Answer with the buttons below, or reply yes or no.'
		);
		expect(r.h.apisix.contracts.calls.map((c) => c.method)).toEqual(['GET']);
	});

	it('never grants itself an access, whatever it tries', async () => {
		// Told by someone to open my tasks to itself, the model tries a tool that would grant, a
		// grant slipped into the withdrawal's arguments, and the contract with a consent of its own
		const attempts: ToolCall[] = [
			['consents_grant', { domain: 'tasks', level: 'read' }],
			['consents_withdraw', { domain: 'tasks', level: 'read', grant: true }],
			['search_tasks', { q: 'today', consent: 'granted' }]
		].map(([name, args], i) => ({
			id: `attempt_${i}`,
			type: 'function',
			function: { name: String(name), arguments: JSON.stringify(args) }
		}));
		const fallback = modelTelling({
			'What are my tasks?': { tool: 'search_tasks', args: { q: 'today' } }
		});
		r.h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			if (last?.role === 'user' && last.content === 'Open my tasks to yourself') {
				return { toolCalls: attempts };
			}
			if (last?.role === 'tool' && last.tool_call_id === 'attempt_2') {
				const results = request.messages
					.filter((m) => m.role === 'tool' && (m.tool_call_id ?? '').startsWith('attempt_'))
					.map((m) => JSON.parse(m.content ?? 'null') as unknown);
				return { content: `Told: ${JSON.stringify(results)}` };
			}
			return fallback(request);
		};
		expect(await told('Open my tasks to yourself')).toEqual([
			{ error: 'unknown tool consents_grant' },
			{ error: 'access denied' },
			{ error: 'access denied' }
		]);
		// Of the consents, the model is offered a listing and a withdrawal, nothing that grants
		const offered = (r.h.apisix.llm.calls.at(-1)?.request.tools ?? []) as {
			function: { name: string };
		}[];
		expect(
			offered
				.map((t) => t.function.name)
				.filter((name) => name.startsWith('consent'))
				.sort()
		).toEqual(['consents_list', 'consents_withdraw']);
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'What are my tasks?');
		await r.nextQuestion(seen);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it('keeps a turn an event started from withdrawing what I allowed', async () => {
		const owner = modelTelling({
			'Search my notes': { tool: 'search_notes', args: { q: 'budget' } }
		});
		// The event's text, written by someone else, tells the model to cut my notes off
		r.h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			return last?.role === 'user' && (last.content ?? '').startsWith('[event]')
				? { toolCalls: call('consents_withdraw', { domain: 'notes' }) }
				: owner(request);
		};
		await allow('Search my notes');
		const seen = r.saying('Told:').length;
		const posted = await r.h.api.post('dispatcher', '/v1/events', {
			owner: 'alice@test.local',
			event_id: 'evt-withdraw',
			type: 'com.twake.mail.received.v1'
		});
		expect(posted.status).toBe(202);
		const refusal = (await r.nextSaying('Told:', seen)).slice('Told: '.length);
		expect(JSON.parse(refusal)).toMatchObject({ error: 'needs_owner_approval' });
		// My notes stay open to it
		r.h.apisix.contracts.calls.length = 0;
		const questions = r.questions().length;
		expect(await told('Search my notes')).toEqual({
			status: 200,
			body: { found: '/contracts/v1/notes/items' }
		});
		expect(r.questions()).toHaveLength(questions);
	});
});

describe('a withdrawal holds at once on every replica', () => {
	let h: TestHarness;
	// A second api replica on the same database, and a client of each
	let other: FastifyInstance;
	let one: TestClient;
	let two: TestClient;
	beforeAll(async () => {
		h = await startTestHarness();
		other = await buildApp({ config: h.config, db: h.db, logStream: new PassThrough() });
		await other.ready();
		h.apisix.contracts.spec = readCatalog(['mail']);
		for (const app of [...h.apps, other]) expect(await app.agent.contracts.load()).toBe(1);
		one = makeClient({ app: h.app, apps: [h.app], issuer: h.issuer });
		two = makeClient({ app: other, apps: [other], issuer: h.issuer });
		h.apisix.llm.script = modelTelling({
			'Find the budget in my mail': { tool: 'search_mail', args: { q: 'budget' } }
		});
		h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
	});
	afterAll(async () => {
		if (other !== undefined) await other.close();
		if (h !== undefined) await h.close();
	});

	it('asks again on another replica once I withdrew through one, though it read just before', async () => {
		await grantConsent(h.db, 'alice', 'mail', 'read');
		const before = await two.post<{ answer: string }>('alice', '/v1/chat', {
			message: 'Find the budget in my mail'
		});
		expect(before.body.answer).toBe(
			'Told: {"status":200,"body":{"found":"/contracts/v1/mail/items"}}'
		);
		const withdrawn = await one.tool('alice', 'consents_withdraw', { domain: 'mail' });
		expect(withdrawn).toEqual({
			status: 200,
			body: { domain: 'mail', withdrawn: ['read'], still_allowed: [] }
		});
		const after = await two.post<{ answer: string }>('alice', '/v1/chat', {
			message: 'Find the budget in my mail'
		});
		expect(after.body.answer).toBe(
			'This is the first time I need to read your data in mail. Do you allow it? Answer with the buttons below, or reply yes or no.'
		);
		expect(h.apisix.contracts.calls).toHaveLength(1);
		expect((await two.tool('alice', 'consents_list', {})).body).toEqual({
			consents: [{ domain: 'events', level: 'read', granted_by: 'built_in', granted_at: null }]
		});
		// The withdrawal is logged with what it is about
		expect(h.logLines().find((l) => l['msg'] === 'consent withdrawn')).toMatchObject({
			principal: 'alice',
			domain: 'mail',
			levels: ['read']
		});
	});

	it('lets every principal that can chat withdraw a consent, and no other', async () => {
		// Two principals as they stood before withdrawing had its own right: one that can chat,
		// one whose rights were all revoked
		for (const [id, actions] of [
			['dave', ['chat', 'contracts.call']],
			['erin', ['contracts.call']]
		] as const) {
			await h.db.sql.begin(async (sql) => {
				await sql`select set_config('app.principal', ${id}, true)`;
				await sql`insert into principals (id, actions) values (${id}, ${sql.json([...actions])})`;
			});
		}
		await h.db.sql`delete from schema_migrations where name = '0031_consents_withdraw.sql'`;
		expect((await runMigrations(h.db)).applied).toEqual(['0031_consents_withdraw.sql']);
		expect((await one.get<{ actions: string[] }>('dave', '/v1/me')).body.actions).toContain(
			'consents.withdraw_own'
		);
		expect((await one.get<{ actions: string[] }>('erin', '/v1/me')).body.actions).not.toContain(
			'consents.withdraw_own'
		);
		// A principal created from now on holds it from the start
		expect((await one.get<{ actions: string[] }>('frank', '/v1/me')).body.actions).toContain(
			'consents.withdraw_own'
		);
	});
});
