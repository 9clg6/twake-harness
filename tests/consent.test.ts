import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withPrincipal } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import { invitationEvent, type ToolCall } from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Three applications as the contracts service names them: mail, which the owner never let the
// assistant use, calendar, which the pilot's assistants used before consents, and events, the
// assistant's own feed of workplace events
const CATALOG = {
	openapi: '3.0.3',
	paths: {
		'/contracts/v1/mail/emails': {
			get: {
				operationId: 'search_emails',
				summary: "Searches the user's mail",
				tags: ['mail.emails.read.v1'],
				parameters: [{ name: 'from', in: 'query', required: false, schema: { type: 'string' } }]
			}
		},
		'/contracts/v1/calendar/freebusy': {
			get: {
				operationId: 'read_freebusy',
				summary: 'Tells whether the user is free between two instants',
				tags: ['calendar.freebusy.read.v1'],
				parameters: [
					{ name: 'start', in: 'query', required: true, schema: { type: 'string' } },
					{ name: 'end', in: 'query', required: true, schema: { type: 'string' } },
					{ name: 'exclude', in: 'query', required: false, schema: { type: 'string' } }
				]
			}
		},
		'/contracts/v1/events/{event_id}': {
			get: {
				operationId: 'read_event',
				summary: 'Reads one stored event of the user',
				tags: ['events.read.v1'],
				parameters: [{ name: 'event_id', in: 'path', required: true, schema: { type: 'string' } }]
			}
		}
	}
};

function call(name: string, args: unknown): ToolCall[] {
	return [
		{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
	];
}

describe('my assistant asks before it first uses an application', () => {
	let h: MatrixTestHarness;
	let alice: MatrixUser;
	let client: E2eeClient;
	let room: string;
	const assistantId = '@twake-space-assistant-alice:test.local';
	beforeAll(async () => {
		h = await startMatrixHarness({ env: { EVENTS_CLIENT_IDS: 'dispatcher' } });
		h.apisix.contracts.spec = CATALOG;
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(3);
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
	}, 240_000);
	afterAll(async () => {
		if (client !== undefined) await client.stop();
		if (h !== undefined) await h.close();
	});
	beforeEach(() => {
		h.apisix.contracts.calls.length = 0;
		h.apisix.contracts.handler = () => ({ status: 200, body: { emails: [] } });
	});

	it('asks before its first read of an application, and calls nothing until I answer', async () => {
		h.apisix.llm.script = () => ({ toolCalls: call('search_emails', { from: 'paul@test.local' }) });
		await client.sendText(room, 'What did Paul send me yesterday?');
		const request = await client.waitForMessage(room, assistantId, (t) =>
			t.startsWith('This is the first time')
		);
		// The question, the call as it would run, and how to answer
		expect(request).toBe(
			[
				'This is the first time I need to read your data in mail. Do you allow it? I would start with this:',
				JSON.stringify({ from: 'paul@test.local' }, null, 2),
				'Answer with the buttons below, or reply yes or no.'
			].join('\n\n')
		);
		expect(h.apisix.contracts.calls).toHaveLength(0);
		// The wait is logged with what it is about, never with what the call would have sent
		const waits = h
			.logLines()
			.filter((line) => line['msg'] === 'contract call waits for its owner');
		expect(waits).toHaveLength(1);
		expect(waits[0]).toMatchObject({
			contract: 'mail.emails.read.v1',
			tool: 'search_emails',
			domain: 'mail',
			level: 'read',
			principal: 'alice@test.local'
		});
		expect(typeof waits[0]?.['pendingCallId']).toBe('string');
		expect(h.logLines().some((line) => JSON.stringify(line).includes('paul@test.local'))).toBe(
			false
		);
	});

	it('reads its own feed of events without asking', async () => {
		h.apisix.contracts.handler = () => ({
			status: 200,
			body: { id: 'evt-7', subject: 'Quarterly figures are out' }
		});
		h.apisix.llm.script = (request) =>
			request.messages.at(-1)?.role === 'tool'
				? { content: 'Your event: Quarterly figures are out' }
				: { toolCalls: call('read_event', { event_id: 'evt-7' }) };
		await client.sendText(room, 'What is event evt-7 about?');
		await client.waitForMessage(room, assistantId, (t) => t.includes('Quarterly figures'));
		expect(h.apisix.contracts.calls.map((c) => c.path)).toEqual(['/contracts/v1/events/evt-7']);
	});

	it("asks before the harness checks an invitation's slot in a calendar it never read", async () => {
		h.apisix.contracts.handler = (c) =>
			c.path.startsWith('/contracts/v1/events/')
				? {
						status: 200,
						body: invitationEvent({
							id: 'evt-inv',
							uid: 'uid-evt-inv',
							title: 'Budget review',
							start: '2026-10-09T09:00:00+02:00',
							end: '2026-10-09T10:00:00+02:00',
							timezone: 'Europe/Paris',
							organizer: 'bob@test.local',
							invitee: 'alice@test.local'
						})
					}
				: { status: 200, body: { free: true, busy: [] } };
		const modelCalls = h.apisix.llm.calls.length;
		const posted = await h.api.post('dispatcher', '/v1/events', {
			owner: 'alice@test.local',
			event_id: 'evt-inv',
			type: 'com.twake.calendar.event.invited.v1'
		});
		expect(posted.status).toBe(202);
		const request = await client.waitForMessage(room, assistantId, (t) =>
			t.includes('your data in calendar')
		);
		expect(request).toBe(
			[
				'This is the first time I need to read your data in calendar. Do you allow it? I would start with this:',
				JSON.stringify(
					{
						start: '2026-10-09T09:00:00+02:00',
						end: '2026-10-09T10:00:00+02:00',
						exclude: ['uid-evt-inv']
					},
					null,
					2
				),
				'Answer with the buttons below, or reply yes or no.'
			].join('\n\n')
		);
		// The harness read the invitation, then stopped at the calendar: no slot read, no model
		expect(h.apisix.contracts.calls.map((c) => c.path)).toEqual(['/contracts/v1/events/evt-inv']);
		expect(h.apisix.llm.calls).toHaveLength(modelCalls);
	});

	it("lets the pilot's assistants read Calendar without asking, as they did before consents", async () => {
		// An owner as they stood before consents: their assistant could call contracts
		await h.db.sql.begin(async (sql) => {
			await sql`select set_config('app.principal', 'dave@test.local', true)`;
			await sql`insert into principals (id, actions)
				values ('dave@test.local', ${sql.json(['chat', 'contracts.call', 'contracts.act'])})`;
		});
		await h.db.sql`delete from schema_migrations where name = '0021_consents_calendar.sql'`;
		expect((await runMigrations(h.db)).applied).toEqual(['0021_consents_calendar.sql']);
		h.apisix.contracts.handler = () => ({ status: 200, body: { free: true, busy: [] } });
		h.apisix.llm.script = (request) =>
			request.messages.at(-1)?.role === 'tool'
				? { content: 'You are free' }
				: {
						toolCalls: call('read_freebusy', {
							start: '2026-10-07T17:00:00+02:00',
							end: '2026-10-07T18:00:00+02:00'
						})
					};
		const res = await h.api.post<{ answer: string }>('dave@test.local', '/v1/chat', {
			message: 'Am I free tomorrow at 5?'
		});
		expect(res.body.answer).toBe('You are free');
		expect(h.apisix.contracts.calls.map((c) => c.path)).toEqual([
			'/contracts/v1/calendar/freebusy'
		]);
	});

	it("keeps an owner's consents and waiting calls out of everyone else's reach", async () => {
		const seen = async (who: string): Promise<{ waiting: string[]; consents: string[] }> =>
			withPrincipal(h.db, { id: who }, async (tx) => ({
				waiting: (await tx.sql<{ owner: string }[]>`select owner from pending_calls`).map(
					(row) => row.owner
				),
				consents: (
					await tx.sql<{ owner: string; domain: string }[]>`select owner, domain from consents`
				).map((row) => `${row.owner} ${row.domain}`)
			}));
		// Alice's call to her mail waits for her; she and Dave kept Calendar when the pilot's
		// migration ran again above
		const alice = await seen('alice@test.local');
		expect(alice.waiting.length).toBeGreaterThan(0);
		expect(new Set(alice.waiting)).toEqual(new Set(['alice@test.local']));
		expect(alice.consents).toEqual(['alice@test.local calendar']);
		expect(await seen('dave@test.local')).toEqual({
			waiting: [],
			consents: ['dave@test.local calendar']
		});
		expect(await seen('bob@test.local')).toEqual({ waiting: [], consents: [] });
		// A transaction that names nobody sees nothing
		expect(await h.db.sql`select 1 from pending_calls`).toHaveLength(0);
		expect(await h.db.sql`select 1 from consents`).toHaveLength(0);
	});
});
