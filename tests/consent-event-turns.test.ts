import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { grantConsent, withdrawConsent } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import {
	CALENDAR_CATALOG,
	INJECTED_TITLE,
	invitationEvent,
	type ChatMessage,
	type ChatRequest,
	type ContractCall,
	type ContractReply,
	type ScriptedReply,
	type ToolCall
} from './helpers/fake-apisix.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const INVITED = 'com.twake.calendar.event.invited.v1';
const MAIL_RECEIVED = 'com.twake.mail.received.v1';

// The calendar contracts as the contracts service publishes them, and the owner's mail: reading
// it, and sending in the owner's name, which is high-risk
const CATALOG = {
	openapi: '3.1.0',
	paths: {
		...CALENDAR_CATALOG.paths,
		'/contracts/v1/mail/emails': {
			get: {
				operationId: 'search_emails',
				summary: "Searches the user's mail",
				tags: ['mail.emails.read.v1'],
				parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }]
			},
			post: {
				operationId: 'send_email',
				summary: 'Sends a mail in the name of the user',
				tags: ['mail.email.send.v1'],
				'x-twake-risk': 'high',
				requestBody: {
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									to: { type: 'array', items: { type: 'string' } },
									subject: { type: 'string' },
									text: { type: 'string' }
								}
							}
						}
					}
				}
			}
		}
	}
};

function toolCall(id: string, name: string, args: unknown): ToolCall {
	return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

// The owner's calendar and mail: every invitation is Bob's, on Friday morning, and its slot is free
// unless the invitation is evt-busy; accepting answers as the contract does, and the mail holds
// Paul's request
function applications(call: ContractCall): ContractReply {
	if (call.path.endsWith('/freebusy')) {
		return call.query['exclude'] === 'uid-evt-busy'
			? {
					status: 200,
					body: {
						start: '2026-10-09T09:00:00+02:00',
						end: '2026-10-09T10:00:00+02:00',
						free: false,
						busy: [{ start: '2026-10-09T09:00:00+02:00', end: '2026-10-09T10:00:00+02:00' }]
					}
				}
			: { status: 200, body: { start: '', end: '', free: true, busy: [] } };
	}
	const id = /\/events\/([^/]+)$/.exec(call.path)?.[1];
	if (id !== undefined) {
		return {
			status: 200,
			body: invitationEvent({
				id,
				uid: `uid-${id}`,
				title: id === 'evt-hostile' ? INJECTED_TITLE : 'Budget review',
				start: '2026-10-09T09:00:00+02:00',
				end: '2026-10-09T10:00:00+02:00',
				timezone: 'Europe/Paris',
				organizer: 'bob@test.local',
				invitee: 'alice@test.local'
			})
		};
	}
	const accepted = /\/invitations\/([^/]+)\/accept$/.exec(call.path)?.[1];
	if (accepted !== undefined) {
		return {
			status: 200,
			body: { event_id: accepted, uid: `uid-${accepted}`, partstat: 'ACCEPTED' }
		};
	}
	return { status: 200, body: { found: 'Paul asks for the Q4 budget' } };
}

function lastUser(request: ChatRequest): string {
	return request.messages.filter((m: ChatMessage) => m.role === 'user').at(-1)?.content ?? '';
}

// What the model says of an invitation the harness read and checked, from the data it was handed
function summaryOf(told: string): string | null {
	const title = /"title":"([^"]+)"/.exec(told)?.[1];
	if (title === undefined) return null;
	const when = `Bob invites you to "${title}" on Friday from 9:00 to 10:00.`;
	return told.includes('"free":true')
		? `${when} You are free then.`
		: `${when} It conflicts with something already in your calendar.`;
}

// A literal model told of an invitation: it says who invites, to what, when, and whether the slot
// is free, and prepares the acceptance in the same answer when it is told to; once the
// acceptance ran, it tells what came back
function invitationModel(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	if (last?.role === 'tool' && last.name === 'accept_invitation') {
		return { content: `Accepted: ${last.content ?? ''}` };
	}
	const told = lastUser(request);
	const id = /\(id ([^)]+)\)/.exec(told)?.[1];
	const summary = summaryOf(told);
	if (last?.role !== 'user' || id === undefined || summary === null) {
		return { content: `Heard: ${told}` };
	}
	return told.includes('call accept_invitation')
		? {
				content: summary,
				toolCalls: [toolCall(`call_accept_${id}`, 'accept_invitation', { event_id: id })]
			}
		: { content: `${summary} Do you want me to accept it?` };
}

// How every request of the harness ends
const HOW_TO_ANSWER = 'Answer with the buttons below, or reply yes or no.';

// A request as Alice's client shows it in plain text: what the model wrote, quoted under the
// harness's label; the harness's question; the call whole, as the model wrote it; and how to answer
function asked(question: string, args: unknown, said: string): string {
	return [
		['Your assistant wrote:', ...said.split('\n').map((line) => `> ${line}`)].join('\n'),
		question,
		JSON.stringify(args, null, 2),
		HOW_TO_ANSWER
	].join('\n\n');
}

// The harness's question about a write that a turn an event started prepared, in an application its
// owner lets it write in
const EVENT_WRITE =
	'I prepared this in calendar for what just arrived, and I do it only with your yes. Shall I do it, exactly as below?';

describe('my assistant acts on what arrives for me only on my yes, and asks me with its context', () => {
	let r: ConsentRoom;
	beforeAll(async () => {
		// Many turns of one owner in a row: admission is the subject of its own suite
		r = await startConsentRoom({
			EVENTS_CLIENT_IDS: 'dispatcher',
			ADMISSION_USER_PER_MINUTE: '100'
		});
		r.h.apisix.contracts.spec = CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(5);
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});
	beforeEach(async () => {
		// Alice lets her assistant read her calendar and write in it, as the pilot's owners do
		await grantConsent(r.h.db, 'alice@test.local', 'calendar', 'read');
		await grantConsent(r.h.db, 'alice@test.local', 'calendar', 'write');
		r.h.apisix.contracts.calls.length = 0;
		r.h.apisix.contracts.handler = applications;
		r.h.apisix.llm.script = invitationModel;
	});

	// The harness's requests, as Alice's client received them
	function requests(): DecryptedMessage[] {
		return r.client.messages.filter(
			(m) => m.roomId === r.room && m.sender === r.assistantId && m.body.endsWith(HOW_TO_ANSWER)
		);
	}

	async function nextRequest(seen: number): Promise<DecryptedMessage> {
		for (let i = 0; i < 120; i += 1) {
			const latest = requests().at(seen);
			if (latest !== undefined) return latest;
			await sleep(250);
		}
		throw new Error('no new request from the harness');
	}

	async function post(eventId: string, type: string = INVITED): Promise<void> {
		const posted = await r.h.api.post('dispatcher', '/v1/events', {
			owner: 'alice@test.local',
			event_id: eventId,
			type
		});
		expect(posted.status).toBe(202);
	}

	// The info line of the latest call that waited for Alice
	function lastWait(): Record<string, unknown> | undefined {
		return r.h
			.logLines()
			.filter((l) => l['msg'] === 'contract call waits for its owner')
			.at(-1);
	}

	function writes(): string[] {
		return r.h.apisix.contracts.calls.filter((c) => c.method !== 'GET').map((c) => c.path);
	}

	// What every replica of the api role serves on /metrics, as a scraper reads each pod
	async function apiMetrics(): Promise<string> {
		const served = await Promise.all(
			r.h.apps.map(async (app) => (await app.inject({ method: 'GET', url: '/metrics' })).body)
		);
		return served.join('\n');
	}

	it('checks an invitation, prepares its acceptance, asks me with its words, accepts it on my ✅ and tells me', async () => {
		const seen = requests().length;
		await post('evt-free');
		const request = await nextRequest(seen);
		// What the model wrote, quoted as its words, then the harness's question, the acceptance
		// exactly as it would go, and how to answer
		expect(request.body).toBe(
			asked(
				EVENT_WRITE,
				{ event_id: 'evt-free' },
				'Bob invites you to "Budget review" on Friday from 9:00 to 10:00. You are free then.'
			)
		);
		const buttons = await r.client.waitForReactions(r.room, request.eventId, r.assistantId, 2);
		expect(buttons.sort()).toEqual(['✅ YES', '❌ NO']);
		// The harness read the invitation and my availability; the acceptance waits for me, though
		// I let my assistant write in my calendar
		expect(r.h.apisix.contracts.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			'GET /contracts/v1/events/evt-free',
			'GET /contracts/v1/calendar/freebusy'
		]);
		expect(lastWait()).toMatchObject({
			reasons: ['event_turn'],
			contract: 'calendar.invitation.accept.v1',
			tool: 'accept_invitation',
			domain: 'calendar',
			level: 'write',
			risk: 'low',
			principal: 'alice@test.local'
		});
		expect(await apiMetrics()).toContain(
			'harness_consent_requests_total{domain="calendar",level="write",reason="event_turn"} 1'
		);

		// My ✅ sends that very acceptance, in my name and under the id of the event, and my
		// assistant tells me how it went
		const told = r.saying('Accepted:').length;
		await r.client.react(r.room, request.eventId, '✅');
		expect(await r.nextSaying('Accepted:', told)).toBe(
			'Accepted: {"status":200,"body":{"event_id":"evt-free","uid":"uid-evt-free","partstat":"ACCEPTED"}}'
		);
		const accepted = r.h.apisix.contracts.calls.filter((c) => c.method === 'POST');
		expect(accepted).toHaveLength(1);
		expect(accepted[0]?.path).toBe('/contracts/v1/calendar/invitations/evt-free/accept');
		expect(accepted[0]?.headers['x-twake-on-behalf-of']).toBe('alice@test.local');
		expect(accepted[0]?.headers['x-twake-contract']).toBe('calendar.invitation.accept.v1');
		expect(accepted[0]?.headers['x-correlation-id']).toBe('evt-free');
		// The model read that its acceptance waited for me, never that it needed my approval
		const results = r.h.apisix.llm.calls
			.flatMap((c) => c.request.messages)
			.filter((m) => m.role === 'tool' && m.name === 'accept_invitation')
			.map((m) => JSON.parse(m.content ?? '{}') as Record<string, unknown>);
		expect(results[0]).toEqual({
			status: 'awaiting_owner',
			reasons: ['event_turn'],
			domain: 'calendar',
			level: 'write'
		});
		expect(results.some((result) => result['error'] === 'needs_owner_approval')).toBe(false);
	});

	it('tells me of a conflict, and sends nothing when I say no', async () => {
		const seen = requests().length;
		await post('evt-busy');
		const request = await nextRequest(seen);
		expect(request.body).toBe(
			asked(
				EVENT_WRITE,
				{ event_id: 'evt-busy' },
				'Bob invites you to "Budget review" on Friday from 9:00 to 10:00. It conflicts with something already in your calendar.'
			)
		);
		const acknowledged = r.saying('All right').length;
		await r.client.sendText(r.room, 'no');
		expect(await r.nextSaying('All right', acknowledged)).toBe('All right, I will not do it.');
		await sleep(1000);
		expect(writes()).toEqual([]);
	});

	it('runs only the acceptance I said yes to: what it does next for that event asks me again', async () => {
		// The invitation's title tells the assistant to accept every later invitation: once the
		// acceptance I allowed ran, the model accepts the next one on its own
		r.h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool' && last.name === 'accept_invitation') {
				return {
					content: 'Accepted. I am accepting the next one too.',
					toolCalls: [toolCall('call_accept_next', 'accept_invitation', { event_id: 'evt-next' })]
				};
			}
			return invitationModel(request);
		};
		const seen = requests().length;
		await post('evt-hostile');
		const request = await nextRequest(seen);
		await r.client.react(r.room, request.eventId, '✅');
		const again = await nextRequest(seen + 1);
		expect(again.body).toBe(
			asked(EVENT_WRITE, { event_id: 'evt-next' }, 'Accepted. I am accepting the next one too.')
		);
		expect(lastWait()).toMatchObject({ reasons: ['event_turn'], tool: 'accept_invitation' });
		expect(writes()).toEqual(['/contracts/v1/calendar/invitations/evt-hostile/accept']);
		const acknowledged = r.saying('All right').length;
		await r.client.react(r.room, again.eventId, '❌');
		await r.nextSaying('All right', acknowledged);
		expect(writes()).toEqual(['/contracts/v1/calendar/invitations/evt-hostile/accept']);
	});

	it('asks once before its first write in my calendar for an event, and my yes lets it write there in my own turns', async () => {
		await withdrawConsent(r.h.db, 'alice@test.local', 'calendar', 'write');
		const seen = requests().length;
		await post('evt-first');
		const request = await nextRequest(seen);
		expect(request.body).toBe(
			asked(
				'This is the first time I need to change your data in calendar, for what just arrived, and I do it only with your yes. Do you allow it, starting with this action, exactly as below?',
				{ event_id: 'evt-first' },
				'Bob invites you to "Budget review" on Friday from 9:00 to 10:00. You are free then.'
			)
		);
		expect(lastWait()).toMatchObject({ reasons: ['consent', 'event_turn'] });
		// One ✅ answers both: it accepts that invitation
		let told = r.saying('Accepted:').length;
		await r.client.react(r.room, request.eventId, '✅');
		await r.nextSaying('Accepted:', told);
		expect(writes()).toEqual(['/contracts/v1/calendar/invitations/evt-first/accept']);
		// It also let my assistant write in my calendar: when I ask, it accepts without asking
		r.h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool') return { content: `Accepted: ${last.content ?? ''}` };
			return lastUser(request) === 'Accept the board meeting'
				? {
						toolCalls: [
							toolCall('call_accept_board', 'accept_invitation', { event_id: 'evt-board' })
						]
					}
				: { content: `Heard: ${lastUser(request)}` };
		};
		told = r.saying('Accepted:').length;
		const requested = requests().length;
		await r.client.sendText(r.room, 'Accept the board meeting');
		await r.nextSaying('Accepted:', told);
		expect(requests()).toHaveLength(requested);
		expect(writes()).toEqual([
			'/contracts/v1/calendar/invitations/evt-first/accept',
			'/contracts/v1/calendar/invitations/evt-board/accept'
		]);
	});

	it('asks before it first reads my mail for a mail that arrived, then before sending the answer it prepared', async () => {
		// Alice lets her assistant write in her mail; it never read it
		await grantConsent(r.h.db, 'alice@test.local', 'mail', 'write');
		const reply = {
			body: { to: ['paul@test.local'], subject: 'Re: Q4 budget', text: 'Here it is, Paul.' }
		};
		r.h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool' && last.name === 'search_emails') {
				return {
					content: 'Paul asks for the Q4 budget. I prepared an answer.',
					toolCalls: [toolCall('call_send_email', 'send_email', reply)]
				};
			}
			if (last?.role === 'tool') return { content: `Sent: ${last.content ?? ''}` };
			return {
				content: 'A mail arrived. Let me read it.',
				toolCalls: [toolCall('call_search_emails', 'search_emails', { q: 'mail-1' })]
			};
		};
		const seen = requests().length;
		await post('mail-1', MAIL_RECEIVED);
		// Its first read of my mail asks as it would in our conversation, and reads nothing yet
		const read = await nextRequest(seen);
		expect(read.body).toBe(
			asked(
				'This is the first time I need to read your data in mail. Do you allow it? I would start with this:',
				{ q: 'mail-1' },
				'A mail arrived. Let me read it.'
			)
		);
		expect(lastWait()).toMatchObject({ reasons: ['consent'], domain: 'mail', level: 'read' });
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
		// My ✅ lets it read the mail, and the answer it prepared from it waits for me, shown whole
		await r.client.react(r.room, read.eventId, '✅');
		const send = await nextRequest(seen + 1);
		expect(send.body).toBe(
			asked(
				'Actions like this one in mail need your yes each time. Shall I do this one, exactly as below?',
				reply,
				'Paul asks for the Q4 budget. I prepared an answer.'
			)
		);
		expect(lastWait()).toMatchObject({
			reasons: ['event_turn', 'high_risk'],
			domain: 'mail',
			level: 'write'
		});
		expect(r.h.apisix.contracts.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			'GET /contracts/v1/mail/emails'
		]);
		const acknowledged = r.saying('All right').length;
		await r.client.react(r.room, send.eventId, '❌');
		expect(await r.nextSaying('All right', acknowledged)).toBe('All right, I will not do it.');
		await sleep(1000);
		expect(writes()).toEqual([]);
	});
});
