import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
	MAIL_RECEIVED,
	mailEvent,
	startActivityExchange,
	type ActivityExchange
} from './helpers/activity.js';
import { startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { grantConsent, withdrawConsent } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import type { ContractCall, ContractReply, ToolCall } from './helpers/fake-apisix.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The owner's mail: reading it, sending in the owner's name, which is high-risk, and turning the
// vacation response off, which takes no arguments
const CATALOG = {
	openapi: '3.1.0',
	paths: {
		'/contracts/v1/mail/vacation': {
			delete: {
				operationId: 'clear_vacation_response',
				summary: "Turns the user's vacation response off",
				tags: ['mail.vacation.set.v1'],
				'x-twake-risk': 'low'
			}
		},
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

// The owner's mail, which holds Paul's request
function applications(_call: ContractCall): ContractReply {
	return { status: 200, body: { found: 'Paul asks for the Q4 budget' } };
}

// How every request of the harness ends
const HOW_TO_ANSWER = 'Answer yes or no in your next message.';

// A request as Alice's client shows it in plain text: what the model wrote, quoted under the
// harness's label; the harness's question; the call whole, as the model wrote it; and how to answer
function asked(question: string, args: unknown, said: string): string {
	return askedAbout(question, JSON.stringify(args, null, 2), said);
}

// The same with what stands in the call's place, such as the tool of a call without arguments, or
// with nothing there under a question that shows no call, a first read's
function askedAbout(question: string, shown: string | null, said: string): string {
	return [
		['Your assistant wrote:', ...said.split('\n').map((line) => `> ${line}`)].join('\n'),
		question,
		...(shown === null ? [] : [shown]),
		HOW_TO_ANSWER
	].join('\n\n');
}

describe('my assistant acts on what arrives for me only on my yes, and asks me with its context', () => {
	let activity: ActivityExchange;
	let r: ConsentRoom;
	beforeAll(async () => {
		activity = await startActivityExchange([MAIL_RECEIVED]);
		// Many turns of one owner in a row: admission is the subject of its own suite
		r = await startConsentRoom({
			...activity.settings,
			ADMISSION_USER_PER_MINUTE: '100'
		});
		r.h.apisix.contracts.spec = CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(3);
		await activity.listen(r.h);
	}, 240_000);
	afterAll(async () => {
		if (activity !== undefined) await activity.close();
		if (r !== undefined) await r.close();
	});
	beforeEach(() => {
		r.h.apisix.contracts.calls.length = 0;
		r.h.apisix.contracts.handler = applications;
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
		await activity.publish(mailEvent('mail-1', 'alice@test.local'));
		// Its first read of my mail asks as it would in our conversation, and reads nothing yet
		const read = await nextRequest(seen);
		expect(read.body).toBe(
			askedAbout(
				'This is the first time I need to read your data in mail. Do you allow it?',
				null,
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

	it('shows me which action it prepared for what arrived when the call has no arguments', async () => {
		await grantConsent(r.h.db, 'alice@test.local', 'mail', 'write');
		const said =
			'Anna writes that your vacation is over. I prepared turning your vacation response off.';
		r.h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool') return { content: `Turned off: ${last.content ?? ''}` };
			return {
				content: said,
				toolCalls: [toolCall('call_clear_vacation', 'clear_vacation_response', {})]
			};
		};
		let seen = requests().length;
		await activity.publish(mailEvent('mail-back', 'alice@test.local'));
		const request = await nextRequest(seen);
		// The tool, as the harness names it, stands under the question in the call's place
		expect(request.body).toBe(
			askedAbout(
				'I prepared this in mail for what just arrived, and I do it only with your yes. Shall I do it, exactly as below?',
				'clear_vacation_response',
				said
			)
		);
		expect(lastWait()).toMatchObject({ reasons: ['event_turn'], tool: 'clear_vacation_response' });
		// My ✅ runs that very call
		const told = r.saying('Turned off:').length;
		await r.client.react(r.room, request.eventId, '✅');
		await r.nextSaying('Turned off:', told);
		expect(writes()).toEqual(['/contracts/v1/mail/vacation']);

		// Its first write in my mail for what arrives asks for both, about that same action
		await withdrawConsent(r.h.db, 'alice@test.local', 'mail', 'write');
		seen = requests().length;
		await activity.publish(mailEvent('mail-back-again', 'alice@test.local'));
		const first = await nextRequest(seen);
		expect(first.body).toBe(
			askedAbout(
				'This is the first time I need to change your data in mail, for what just arrived, and I do it only with your yes. Do you allow it, starting with this action, exactly as below?',
				'clear_vacation_response',
				said
			)
		);
		expect(lastWait()).toMatchObject({ reasons: ['consent', 'event_turn'] });
		const acknowledged = r.saying('All right').length;
		await r.client.react(r.room, first.eventId, '❌');
		await r.nextSaying('All right', acknowledged);
		expect(writes()).toEqual(['/contracts/v1/mail/vacation']);
	});
});
