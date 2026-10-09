import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withPrincipal } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import type { ToolCall } from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Three applications as the contracts service names them: mail, which the owner never let the
// assistant use, calendar, which the pilot's assistants used before consents, and tasks
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
		'/contracts/v1/calendar/invitations/{event_id}/accept': {
			post: {
				operationId: 'accept_invitation',
				summary: 'Accepts an invitation, once the user has said yes to this very invitation',
				tags: ['calendar.invitation.accept.v1'],
				'x-twake-risk': 'low',
				parameters: [{ name: 'event_id', in: 'path', required: true, schema: { type: 'string' } }]
			}
		},
		'/contracts/v1/tasks/mine': {
			get: {
				operationId: 'list_my_tasks',
				summary: 'Lists the tasks assigned to the user',
				tags: ['tasks.task.read.v1'],
				parameters: [
					{ name: 'zone', in: 'query', required: true, schema: { type: 'string' } },
					{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }
				]
			}
		},
		'/contracts/v1/tasks/boards/{board_id}/tasks/{task_id}/complete': {
			post: {
				operationId: 'complete_task',
				summary: 'Marks a task of a board as done',
				tags: ['tasks.task.complete.v1'],
				'x-twake-risk': 'low',
				parameters: [
					{ name: 'board_id', in: 'path', required: true, schema: { type: 'string' } },
					{ name: 'task_id', in: 'path', required: true, schema: { type: 'string' } }
				]
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
		h = await startMatrixHarness();
		h.apisix.contracts.spec = CATALOG;
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(5);
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
		// The question, about reading in the application whatever the call, and how to answer
		expect(request).toBe(
			[
				'This is the first time I need to read your data in mail. Do you allow it?',
				'Answer yes or no in your next message.'
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

	it('asks every owner again before it reads their calendar, now that reading it covers their events', async () => {
		// Alice and Dave read Calendar on the pilot's grant, run again above; Erin allowed it herself
		// when reading it meant her free and busy times alone; Alice also lets her assistant write there
		const allow = (owner: string, level: string, source: string): Promise<unknown> =>
			withPrincipal(
				h.db,
				{ id: owner },
				(tx) =>
					tx.sql`insert into consents (owner, domain, level, granted_by)
						values (${owner}, 'calendar', ${level}, ${source})`
			);
		await allow('erin@test.local', 'read', 'chat');
		await allow('alice@test.local', 'write', 'api');
		// Frank was asked whether his assistant may read his calendar, in the words that meant his free
		// and busy times alone, and has not answered yet
		const slot = { start: '2026-10-07T17:00:00+02:00', end: '2026-10-07T18:00:00+02:00' };
		h.apisix.llm.script = () => ({ toolCalls: call('read_freebusy', slot) });
		const asked = await h.api.post<{ pending_call: { id: string } }>(
			'frank@test.local',
			'/v1/chat',
			{
				message: 'Am I free tomorrow at 5?'
			}
		);
		await h.db.sql`delete from schema_migrations where name = '0067_consents_calendar_reask.sql'`;
		expect((await runMigrations(h.db)).applied).toEqual(['0067_consents_calendar_reask.sql']);
		const consentsOf = async (owner: string): Promise<string[]> =>
			withPrincipal(h.db, { id: owner }, async (tx) =>
				(await tx.sql<{ domain: string; level: string }[]>`select domain, level from consents`).map(
					(row) => `${row.domain} ${row.level}`
				)
			);
		const waitingOf = async (owner: string): Promise<string[]> =>
			withPrincipal(h.db, { id: owner }, async (tx) =>
				(
					await tx.sql<{ domain: string; level: string }[]>`
						select domain, level from pending_calls where status = 'open'`
				).map((row) => `${row.domain} ${row.level}`)
			);
		// Calendar read went, whoever gave it; what else an owner allowed stays
		expect(await consentsOf('alice@test.local')).toEqual(['calendar write']);
		expect(await consentsOf('dave@test.local')).toEqual([]);
		expect(await consentsOf('erin@test.local')).toEqual([]);
		// A request to read it, asked in the old words, waits no more; Alice's to read her mail does
		expect(await waitingOf('frank@test.local')).toEqual([]);
		expect(await waitingOf('alice@test.local')).toEqual(['mail read']);
		// Frank's yes to it comes too late, and allows nothing
		expect(
			await h.api.post(
				'frank@test.local',
				`/v1/pending-calls/${asked.body.pending_call.id}/approve`,
				{}
			)
		).toEqual({ status: 409, body: { error: 'pending call closed', state: 'expired' } });
		expect(await consentsOf('frank@test.local')).toEqual([]);
		// Dave's next read of his calendar waits for his answer, as a first read does
		const res = await h.api.post<{ answer: string }>('dave@test.local', '/v1/chat', {
			message: 'Am I free tomorrow at 5?'
		});
		expect(res.body.answer).toBe(
			[
				'This is the first time I need to read your data in calendar. Do you allow it?',
				'Answer yes or no in your next message.'
			].join('\n\n')
		);
		expect(h.apisix.contracts.calls).toHaveLength(0);
	});

	it('asks every owner again before it writes in their calendar, now that writing there covers declining', async () => {
		// Alice let her assistant write in her calendar through the API, and kept that when reading it
		// was asked again above; Frank let his write there in the chat. Erin allows reading her
		// calendar again, in the new words, and reading her mail.
		await withPrincipal(
			h.db,
			{ id: 'frank@test.local' },
			(tx) => tx.sql`insert into consents (owner, domain, level, granted_by)
				values ('frank@test.local', 'calendar', 'write', 'chat')`
		);
		await withPrincipal(
			h.db,
			{ id: 'erin@test.local' },
			(tx) => tx.sql`insert into consents (owner, domain, level, granted_by)
				values ('erin@test.local', 'calendar', 'read', 'chat'),
					('erin@test.local', 'mail', 'read', 'chat')`
		);
		// Dave, whose request to read his calendar still waits from above, was asked whether his
		// assistant may accept an invitation there, in the words that meant accepting alone, and has
		// not answered yet
		h.apisix.llm.script = () => ({
			toolCalls: call('accept_invitation', { event_id: 'uid-friday' })
		});
		const asked = await h.api.post<{ pending_call: { id: string } }>(
			'dave@test.local',
			'/v1/chat',
			{
				message: 'Accept the meeting on Friday'
			}
		);
		const migration = '0068_consents_calendar_write_reask.sql';
		await h.db.sql`delete from schema_migrations where name = ${migration}`;
		expect((await runMigrations(h.db)).applied).toEqual([migration]);
		const seen = async (owner: string): Promise<{ consents: string[]; waiting: string[] }> =>
			withPrincipal(h.db, { id: owner }, async (tx) => {
				const named = (rows: { domain: string; level: string }[]): string[] =>
					rows.map((row) => `${row.domain} ${row.level}`);
				return {
					consents: named(
						await tx.sql<{ domain: string; level: string }[]>`
							select domain, level from consents order by domain, level`
					),
					waiting: named(
						await tx.sql<{ domain: string; level: string }[]>`
							select domain, level from pending_calls where status = 'open' order by domain, level`
					)
				};
			});
		// Calendar write went, whoever gave it, and so did the request to write there; reading it, and
		// every other application, stay as their owners left them
		expect(await seen('alice@test.local')).toEqual({ consents: [], waiting: ['mail read'] });
		expect(await seen('frank@test.local')).toEqual({ consents: [], waiting: [] });
		expect(await seen('dave@test.local')).toEqual({ consents: [], waiting: ['calendar read'] });
		expect(await seen('erin@test.local')).toEqual({
			consents: ['calendar read', 'mail read'],
			waiting: []
		});
		// Dave's yes to it comes too late, and allows nothing
		expect(
			await h.api.post(
				'dave@test.local',
				`/v1/pending-calls/${asked.body.pending_call.id}/approve`,
				{}
			)
		).toEqual({ status: 409, body: { error: 'pending call closed', state: 'expired' } });
		expect(await seen('dave@test.local')).toEqual({ consents: [], waiting: ['calendar read'] });
		expect(h.apisix.contracts.calls).toHaveLength(0);
	});

	it('asks every owner again before it reads or writes their tasks, now that both cover more', async () => {
		// Reading Tasks now lists the owner's projects too, and writing there creates projects, and
		// assigns, comments on and deletes tasks. Alice let her assistant read her tasks through the API
		// and write there in the chat; Frank let his write there through the API, and lets it write in
		// his calendar again, in the new words; Erin let hers read her tasks in the chat.
		await withPrincipal(
			h.db,
			{ id: 'alice@test.local' },
			(tx) => tx.sql`insert into consents (owner, domain, level, granted_by)
				values ('alice@test.local', 'tasks', 'read', 'api'),
					('alice@test.local', 'tasks', 'write', 'chat')`
		);
		await withPrincipal(
			h.db,
			{ id: 'frank@test.local' },
			(tx) => tx.sql`insert into consents (owner, domain, level, granted_by)
				values ('frank@test.local', 'tasks', 'write', 'api'),
					('frank@test.local', 'calendar', 'write', 'chat')`
		);
		await withPrincipal(
			h.db,
			{ id: 'erin@test.local' },
			(tx) => tx.sql`insert into consents (owner, domain, level, granted_by)
				values ('erin@test.local', 'tasks', 'read', 'chat')`
		);
		const seen = async (owner: string): Promise<{ consents: string[]; waiting: string[] }> =>
			withPrincipal(h.db, { id: owner }, async (tx) => {
				const named = (rows: { domain: string; level: string }[]): string[] =>
					rows.map((row) => `${row.domain} ${row.level}`);
				return {
					consents: named(
						await tx.sql<{ domain: string; level: string }[]>`
							select domain, level from consents order by domain, level`
					),
					waiting: named(
						await tx.sql<{ domain: string; level: string }[]>`
							select domain, level from pending_calls where status = 'open' order by domain, level`
					)
				};
			});
		// Frank was asked whether his assistant may read his tasks, and Erin whether hers may write
		// there, in the words of before, and neither has answered yet
		h.apisix.llm.script = () => ({
			toolCalls: call('list_my_tasks', { zone: 'Europe/Paris', limit: 5 })
		});
		const reading = await h.api.post<{ pending_call: { id: string } }>(
			'frank@test.local',
			'/v1/chat',
			{ message: 'What are my tasks?' }
		);
		h.apisix.llm.script = () => ({
			toolCalls: call('complete_task', { board_id: 'board-1', task_id: 'task-call-paul' })
		});
		const writing = await h.api.post<{ pending_call: { id: string } }>(
			'erin@test.local',
			'/v1/chat',
			{ message: 'I called Paul, mark it as done' }
		);
		expect((await seen('frank@test.local')).waiting).toEqual(['tasks read']);
		expect((await seen('erin@test.local')).waiting).toEqual(['tasks write']);
		const migration = '0069_consents_tasks_reask.sql';
		await h.db.sql`delete from schema_migrations where name = ${migration}`;
		expect((await runMigrations(h.db)).applied).toEqual([migration]);
		// Tasks read and write went, whoever gave them, and so did the requests to read or write there;
		// Calendar, Mail and every other application stay as their owners left them
		expect(await seen('alice@test.local')).toEqual({ consents: [], waiting: ['mail read'] });
		expect(await seen('frank@test.local')).toEqual({ consents: ['calendar write'], waiting: [] });
		expect(await seen('dave@test.local')).toEqual({ consents: [], waiting: ['calendar read'] });
		expect(await seen('erin@test.local')).toEqual({
			consents: ['calendar read', 'mail read'],
			waiting: []
		});
		// A yes to either comes too late, and allows nothing
		for (const [owner, asked] of [
			['frank@test.local', reading],
			['erin@test.local', writing]
		] as const) {
			expect(
				await h.api.post(owner, `/v1/pending-calls/${asked.body.pending_call.id}/approve`, {})
			).toEqual({ status: 409, body: { error: 'pending call closed', state: 'expired' } });
		}
		expect(await seen('frank@test.local')).toEqual({ consents: ['calendar write'], waiting: [] });
		expect(await seen('erin@test.local')).toEqual({
			consents: ['calendar read', 'mail read'],
			waiting: []
		});
		// Erin's next read of her tasks waits for her answer, as a first read does
		h.apisix.llm.script = () => ({
			toolCalls: call('list_my_tasks', { zone: 'Europe/Paris', limit: 5 })
		});
		const res = await h.api.post<{ answer: string }>('erin@test.local', '/v1/chat', {
			message: 'What are my tasks?'
		});
		expect(res.body.answer).toBe(
			[
				'This is the first time I need to read your data in tasks. Do you allow it?',
				'Answer yes or no in your next message.'
			].join('\n\n')
		);
		expect(h.apisix.contracts.calls).toHaveLength(0);
	});

	it('asks every owner again before it reads or writes in their calendar, now that both cover meetings', async () => {
		// Reading Calendar now finds when the owner and others are free, and writing there calls
		// meetings, which email everyone invited. Alice let her assistant read her calendar through the
		// API; Frank kept his writing there, allowed in the chat above; Erin kept hers reading it, and
		// lets it write there through the API.
		await withPrincipal(
			h.db,
			{ id: 'alice@test.local' },
			(tx) => tx.sql`insert into consents (owner, domain, level, granted_by)
				values ('alice@test.local', 'calendar', 'read', 'api')`
		);
		await withPrincipal(
			h.db,
			{ id: 'erin@test.local' },
			(tx) => tx.sql`insert into consents (owner, domain, level, granted_by)
				values ('erin@test.local', 'calendar', 'write', 'api')`
		);
		const seen = async (owner: string): Promise<{ consents: string[]; waiting: string[] }> =>
			withPrincipal(h.db, { id: owner }, async (tx) => {
				const named = (rows: { domain: string; level: string }[]): string[] =>
					rows.map((row) => `${row.domain} ${row.level}`);
				return {
					consents: named(
						await tx.sql<{ domain: string; level: string }[]>`
							select domain, level from consents order by domain, level`
					),
					waiting: named(
						await tx.sql<{ domain: string; level: string }[]>`
							select domain, level from pending_calls where status = 'open' order by domain, level`
					)
				};
			});
		// Frank was asked whether his assistant may read his calendar, and Dave, whose request to read
		// his still waits from above, whether his may accept an invitation there, in the words of
		// before, and neither has answered yet
		const slot = { start: '2026-10-07T17:00:00+02:00', end: '2026-10-07T18:00:00+02:00' };
		h.apisix.llm.script = () => ({ toolCalls: call('read_freebusy', slot) });
		const reading = await h.api.post<{ pending_call: { id: string } }>(
			'frank@test.local',
			'/v1/chat',
			{ message: 'Am I free tomorrow at 5?' }
		);
		h.apisix.llm.script = () => ({
			toolCalls: call('accept_invitation', { event_id: 'uid-friday' })
		});
		const writing = await h.api.post<{ pending_call: { id: string } }>(
			'dave@test.local',
			'/v1/chat',
			{ message: 'Accept the meeting on Friday' }
		);
		expect(await seen('frank@test.local')).toEqual({
			consents: ['calendar write'],
			waiting: ['calendar read']
		});
		expect(await seen('dave@test.local')).toEqual({
			consents: [],
			waiting: ['calendar read', 'calendar write']
		});
		const migration = '0076_consents_calendar_meetings_reask.sql';
		await h.db.sql`delete from schema_migrations where name = ${migration}`;
		expect((await runMigrations(h.db)).applied).toEqual([migration]);
		// Calendar read and write went, whoever gave them, and so did the requests to read or write
		// there; Tasks, Mail and every other application stay as their owners left them
		expect(await seen('alice@test.local')).toEqual({ consents: [], waiting: ['mail read'] });
		expect(await seen('frank@test.local')).toEqual({ consents: [], waiting: [] });
		expect(await seen('dave@test.local')).toEqual({ consents: [], waiting: [] });
		expect(await seen('erin@test.local')).toEqual({
			consents: ['mail read'],
			waiting: ['tasks read']
		});
		// A yes to either comes too late, and allows nothing
		for (const [owner, asked] of [
			['frank@test.local', reading],
			['dave@test.local', writing]
		] as const) {
			expect(
				await h.api.post(owner, `/v1/pending-calls/${asked.body.pending_call.id}/approve`, {})
			).toEqual({ status: 409, body: { error: 'pending call closed', state: 'expired' } });
		}
		expect(await seen('frank@test.local')).toEqual({ consents: [], waiting: [] });
		expect(await seen('dave@test.local')).toEqual({ consents: [], waiting: [] });
		// Erin's next read of her calendar, and Frank's next write there, wait for their answers, as a
		// first read and a first write do
		h.apisix.llm.script = () => ({ toolCalls: call('read_freebusy', slot) });
		const read = await h.api.post<{ answer: string }>('erin@test.local', '/v1/chat', {
			message: 'Am I free tomorrow at 5?'
		});
		expect(read.body.answer).toBe(
			[
				'This is the first time I need to read your data in calendar. Do you allow it? I would start with this:',
				JSON.stringify(slot, null, 2),
				'Answer yes or no in your next message.'
			].join('\n\n')
		);
		h.apisix.llm.script = () => ({
			toolCalls: call('accept_invitation', { event_id: 'uid-friday' })
		});
		const write = await h.api.post<{ answer: string }>('frank@test.local', '/v1/chat', {
			message: 'Accept the meeting on Friday'
		});
		expect(write.body.answer).toBe(
			[
				'This is the first time I need to change your data in calendar. Do you allow it? I would start with this:',
				JSON.stringify({ event_id: 'uid-friday' }, null, 2),
				'Answer yes or no in your next message.'
			].join('\n\n')
		);
		expect(h.apisix.contracts.calls).toHaveLength(0);
	});
});
