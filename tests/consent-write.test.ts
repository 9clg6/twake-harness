import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../src/db/migrate.js';
import { call, modelFor, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { grantConsent } from './helpers/consents.js';

// The owner's calendar, which the assistant reads with a GET and writes with a POST, and their
// tasks, written with a PATCH: any method but GET writes
const CATALOG = {
	openapi: '3.0.3',
	paths: {
		'/contracts/v1/calendar/freebusy': {
			get: {
				operationId: 'read_freebusy',
				summary: 'Tells whether the user is free between two instants',
				tags: ['calendar.freebusy.read.v1'],
				parameters: [
					{ name: 'start', in: 'query', required: true, schema: { type: 'string' } },
					{ name: 'end', in: 'query', required: true, schema: { type: 'string' } }
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
		'/contracts/v1/calendar/invitations/{event_id}/decline': {
			post: {
				operationId: 'decline_invitation',
				summary: 'Declines an invitation, once the user has said no to this very invitation',
				tags: ['calendar.invitation.decline.v1'],
				'x-twake-risk': 'low',
				parameters: [{ name: 'event_id', in: 'path', required: true, schema: { type: 'string' } }]
			}
		},
		'/contracts/v1/tasks/{task_id}': {
			patch: {
				operationId: 'complete_task',
				summary: "Marks one of the user's tasks done",
				tags: ['tasks.task.complete.v1'],
				'x-twake-risk': 'low',
				parameters: [{ name: 'task_id', in: 'path', required: true, schema: { type: 'string' } }],
				requestBody: {
					content: {
						'application/json': {
							schema: { type: 'object', properties: { done: { type: 'boolean' } } }
						}
					}
				}
			}
		}
	}
};

// A literal model: the tool each request of the owner needs, as the owner words it
const REQUESTS = {
	'Am I free on Friday at 9?': {
		tool: 'read_freebusy',
		args: { start: '2026-10-09T09:00:00+02:00', end: '2026-10-09T10:00:00+02:00' }
	},
	'Accept the budget review': { tool: 'accept_invitation', args: { event_id: 'evt-budget' } },
	'Decline the offsite': { tool: 'decline_invitation', args: { event_id: 'evt-offsite' } },
	'Mark the Q4 figures task done': {
		tool: 'complete_task',
		args: { task_id: 'task-q4', body: { done: true } }
	},
	'Accept the board meeting': { tool: 'accept_invitation', args: { event_id: 'evt-board' } }
};

describe('my assistant asks again before it first writes in an application', () => {
	let r: ConsentRoom;
	beforeAll(async () => {
		// Many turns of one owner in a row: admission is the subject of its own suite
		r = await startConsentRoom({ ADMISSION_USER_PER_MINUTE: '100' });
		r.h.apisix.contracts.spec = CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(4);
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});
	beforeEach(() => {
		r.h.apisix.llm.script = modelFor(REQUESTS);
		r.h.apisix.contracts.calls.length = 0;
		r.h.apisix.contracts.handler = (c) => ({
			status: 200,
			body: { done: `${c.method} ${c.path}` }
		});
	});

	it('asks before its first write in my calendar, though I let it read there, and writes on my ✅', async () => {
		// I let my assistant read my calendar, once its question shows its buttons
		let seen = r.questions().length;
		await r.client.sendText(r.room, 'Am I free on Friday at 9?');
		const read = await r.nextQuestion(seen);
		await r.client.waitForReactions(r.room, read, r.assistantId, 2);
		let found = r.saying('Found:').length;
		await r.client.react(r.room, read, '✅');
		await r.nextSaying('Found:', found);
		r.h.apisix.contracts.calls.length = 0;

		// Its first write there asks again, for writing, and nothing reaches my calendar
		seen = r.questions().length;
		const asked = await r.client.sendText(r.room, 'Accept the budget review');
		const question = await r.nextQuestion(seen);
		expect(r.questions().at(-1)?.body).toBe(
			[
				'This is the first time I need to change your data in calendar. Do you allow it? I would start with this:',
				JSON.stringify({ event_id: 'evt-budget' }, null, 2),
				'Answer with the buttons below, or reply yes or no.'
			].join('\n\n')
		);
		const buttons = await r.client.waitForReactions(r.room, question, r.assistantId, 2);
		expect(buttons.sort()).toEqual(['✅ YES', '❌ NO']);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
		// The wait is logged with what it is about, never with what the call would have sent
		expect(
			r.h
				.logLines()
				.filter((l) => l['msg'] === 'contract call waits for its owner')
				.at(-1)
		).toMatchObject({
			contract: 'calendar.invitation.accept.v1',
			tool: 'accept_invitation',
			domain: 'calendar',
			level: 'write',
			principal: 'alice@test.local'
		});
		expect(r.h.logLines().some((l) => JSON.stringify(l).includes('evt-budget'))).toBe(false);

		// My ✅ runs the call as the model wrote it, in my name and under the id of my request
		found = r.saying('Found:').length;
		await r.client.react(r.room, question, '✅');
		expect(await r.nextSaying('Found:', found)).toContain(
			'POST /contracts/v1/calendar/invitations/evt-budget/accept'
		);
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
		const accepted = r.h.apisix.contracts.calls[0];
		expect(accepted?.method).toBe('POST');
		expect(accepted?.path).toBe('/contracts/v1/calendar/invitations/evt-budget/accept');
		expect(accepted?.headers['x-twake-on-behalf-of']).toBe('alice@test.local');
		expect(accepted?.headers['x-twake-contract']).toBe('calendar.invitation.accept.v1');
		expect(accepted?.headers['x-correlation-id']).toBe(asked);
	});

	it('writes in my calendar again without asking, once I allowed it', async () => {
		const seen = r.questions().length;
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'Decline the offsite');
		expect(await r.nextSaying('Found:', found)).toContain(
			'POST /contracts/v1/calendar/invitations/evt-offsite/decline'
		);
		expect(r.questions()).toHaveLength(seen);
		expect(r.h.apisix.contracts.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			'POST /contracts/v1/calendar/invitations/evt-offsite/decline'
		]);
	});

	it('asks before its first write in each application, whatever the method, and my yes allows it', async () => {
		// Writing in my calendar lets it write nowhere else
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Mark the Q4 figures task done');
		const question = await r.nextQuestion(seen);
		expect(r.questions().at(-1)?.body).toBe(
			[
				'This is the first time I need to change your data in tasks. Do you allow it? I would start with this:',
				JSON.stringify({ task_id: 'task-q4', body: { done: true } }, null, 2),
				'Answer with the buttons below, or reply yes or no.'
			].join('\n\n')
		);
		await r.client.waitForReactions(r.room, question, r.assistantId, 2);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'yes');
		expect(await r.nextSaying('Found:', found)).toContain('PATCH /contracts/v1/tasks/task-q4');
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
		expect(r.h.apisix.contracts.calls[0]?.method).toBe('PATCH');
		expect(r.h.apisix.contracts.calls[0]?.body).toEqual({ done: true });
	});

	it('refuses, as before, an owner who may not act through contracts, whatever they allowed', async () => {
		// Erin may call contracts but not act through them, and she allowed her calendar both ways
		await r.h.db.sql.begin(async (sql) => {
			await sql`select set_config('app.principal', 'erin@test.local', true)`;
			await sql`insert into principals (id, actions)
				values ('erin@test.local', ${sql.json(['chat', 'contracts.call'])})`;
		});
		await grantConsent(r.h.db, 'erin@test.local', 'calendar', 'read');
		await grantConsent(r.h.db, 'erin@test.local', 'calendar', 'write');
		const direct = await r.h.api.tool('erin@test.local', 'accept_invitation', {
			event_id: 'evt-erin'
		});
		expect(direct.status).toBe(403);
		// Her model is told it may not, and no question is asked
		r.h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			return last?.role === 'tool'
				? { content: `Told: ${last.content ?? ''}` }
				: { toolCalls: call('accept_invitation', { event_id: 'evt-erin' }) };
		};
		const res = await r.h.api.post<{ answer: string }>('erin@test.local', '/v1/chat', {
			message: 'Accept the budget review'
		});
		expect(res.body.answer).toBe('Told: {"error":"access denied"}');
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
	});

	it("lets the pilot's assistants accept an invitation without asking, as they did before", async () => {
		// An owner as they stood before writing needed its own consent: their assistant could act
		// through contracts. Every owner who may act gets Calendar write when this runs again,
		// Alice included, so this test comes after hers.
		await r.h.db.sql.begin(async (sql) => {
			await sql`select set_config('app.principal', 'dave@test.local', true)`;
			await sql`insert into principals (id, actions)
				values ('dave@test.local', ${sql.json(['chat', 'contracts.call', 'contracts.act'])})`;
		});
		await r.h.db.sql`delete from schema_migrations where name = '0040_consents_calendar_write.sql'`;
		expect((await runMigrations(r.h.db)).applied).toEqual(['0040_consents_calendar_write.sql']);
		const res = await r.h.api.post<{ answer: string }>('dave@test.local', '/v1/chat', {
			message: 'Accept the board meeting'
		});
		expect(res.body.answer).toContain('POST /contracts/v1/calendar/invitations/evt-board/accept');
		expect(r.h.apisix.contracts.calls).toHaveLength(1);
		expect(r.h.apisix.contracts.calls[0]?.headers['x-twake-on-behalf-of']).toBe('dave@test.local');
	});
});
