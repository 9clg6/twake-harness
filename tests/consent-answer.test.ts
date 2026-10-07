import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startE2eeClient, type DecryptedMessage, type E2eeClient } from './helpers/e2ee-client.js';
import {
	INJECTED_NOTE,
	INJECTED_TITLE,
	invitationEvent,
	type ChatRequest,
	type LlmScript,
	type ToolCall
} from './helpers/fake-apisix.js';
import { withdrawConsent } from './helpers/consents.js';
import { eventually, watchFeedback, type RoomFeedback } from './helpers/feedback.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Applications the owner never let the assistant use, and the assistant's own feed of events
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
		'/contracts/v1/events/{event_id}': {
			get: {
				operationId: 'read_event',
				summary: 'Reads one stored event of the user',
				tags: ['events.read.v1'],
				parameters: [{ name: 'event_id', in: 'path', required: true, schema: { type: 'string' } }]
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
				parameters: [{ name: 'event_id', in: 'path', required: true, schema: { type: 'string' } }]
			}
		},
		'/contracts/v1/chat/rooms': {
			get: {
				operationId: 'list_rooms',
				summary: "Lists the user's rooms",
				tags: ['chat.rooms.read.v1'],
				parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'string' } }]
			}
		},
		'/contracts/v1/contacts': {
			get: {
				operationId: 'search_contacts',
				summary: "Searches the user's contacts",
				tags: ['contacts.people.read.v1'],
				parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }]
			}
		},
		'/contracts/v1/notes': {
			get: {
				operationId: 'search_notes',
				summary: "Searches the user's notes",
				tags: ['notes.page.read.v1'],
				parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }]
			}
		},
		'/contracts/v1/tasks/mine': {
			get: {
				operationId: 'list_my_tasks',
				summary: 'Lists the tasks assigned to the user',
				tags: ['tasks.task.read.v1'],
				parameters: [{ name: 'due', in: 'query', required: false, schema: { type: 'string' } }]
			}
		},
		'/contracts/v1/drive/files': {
			get: {
				operationId: 'search_files',
				summary: "Searches the user's files by name",
				tags: ['drive.file.read.v1'],
				parameters: [{ name: 'name', in: 'query', required: true, schema: { type: 'string' } }]
			}
		}
	}
};

function call(name: string, args: unknown): ToolCall[] {
	return [
		{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
	];
}

// A literal model: it calls the tool its owner's request needs, and once a call came back with
// data it tells what it found
function modelUsing(
	tool: string,
	args: unknown
): (request: ChatRequest) => {
	content?: string;
	toolCalls?: ToolCall[];
} {
	return (request) => {
		const last = request.messages.at(-1);
		if (last?.role === 'tool' && (last.content ?? '').includes('"status":200')) {
			return { content: `Found: ${last.content ?? ''}` };
		}
		return { toolCalls: call(tool, args) };
	};
}

describe('my answer lets my assistant carry on', () => {
	let h: MatrixTestHarness;
	let alice: MatrixUser;
	let client: E2eeClient;
	let room: string;
	let feedback: RoomFeedback;
	const assistantId = '@twake-space-assistant-alice:test.local';
	beforeAll(async () => {
		// Many turns of one owner in a row: admission is the subject of its own suite below
		h = await startMatrixHarness({
			env: { EVENTS_CLIENT_IDS: 'dispatcher', ADMISSION_USER_PER_MINUTE: '100' }
		});
		h.apisix.contracts.spec = CATALOG;
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(9);
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
		feedback = watchFeedback({ synapse: h.synapse, owner: alice, client, room, assistantId });
	}, 240_000);
	afterAll(async () => {
		if (client !== undefined) await client.stop();
		if (h !== undefined) await h.close();
	});
	beforeEach(() => {
		h.apisix.contracts.calls.length = 0;
		h.apisix.contracts.handler = (c) => ({
			status: 200,
			body: {
				found: c.path.includes('mail')
					? 'Budget from Paul'
					: c.path.includes('tasks')
						? 'Send the Q4 figures'
						: c.path.includes('chat')
							? 'Team room'
							: 'Q4 plan.pdf'
			}
		});
	});

	// The harness's requests, as the owner's client received them
	function requests(): DecryptedMessage[] {
		return client.messages.filter(
			(m) =>
				m.roomId === room && m.sender === assistantId && m.body.startsWith('This is the first time')
		);
	}

	// The assistant's answers built from a contract's data, as the model above writes them
	function answers(): DecryptedMessage[] {
		return client.messages.filter(
			(m) => m.roomId === room && m.sender === assistantId && m.body.startsWith('Found:')
		);
	}

	// The notices of the turns that failed
	function failures(): DecryptedMessage[] {
		return client.messages.filter(
			(m) =>
				m.roomId === room && m.sender === assistantId && m.body.startsWith('Something went wrong')
		);
	}

	async function nextAnswer(seen: number): Promise<string> {
		for (let i = 0; i < 120; i += 1) {
			const latest = answers().at(seen);
			if (latest !== undefined) return latest.body;
			await sleep(250);
		}
		throw new Error('no new answer from the assistant');
	}

	async function nextRequest(seen: number): Promise<string> {
		for (let i = 0; i < 120; i += 1) {
			const latest = requests().at(seen);
			if (latest !== undefined) return latest.eventId;
			await sleep(250);
		}
		throw new Error('no new request from the harness');
	}

	it('runs the frozen call when I react ✅ to the request, then answers my question', async () => {
		h.apisix.llm.script = modelUsing('search_emails', { from: 'paul@test.local' });
		const seen = requests().length;
		const answered = answers().length;
		const asked = await client.sendText(room, 'What did Paul send me yesterday?');
		const request = await nextRequest(seen);
		expect(h.apisix.contracts.calls).toHaveLength(0);
		await client.react(room, request, '✅');
		expect(await nextAnswer(answered)).toContain('Budget from Paul');
		expect(h.apisix.contracts.calls).toHaveLength(1);
		const replayed = h.apisix.contracts.calls[0];
		expect(replayed?.path).toBe('/contracts/v1/mail/emails');
		expect(replayed?.query).toEqual({ from: 'paul@test.local' });
		expect(replayed?.headers['x-twake-on-behalf-of']).toBe('alice@test.local');
		expect(replayed?.headers['x-correlation-id']).toBe(asked);
		// The answer and the replay are logged with what they are about, never with the arguments
		const answeredLine = h.logLines().find((l) => l['msg'] === 'owner answered');
		expect(answeredLine).toMatchObject({
			owner: 'alice@test.local',
			answer: 'yes',
			via: 'reaction'
		});
		expect(h.logLines().find((l) => l['msg'] === 'pending call replayed')).toMatchObject({
			pendingCallId: answeredLine?.['pendingCallId'],
			tool: 'search_emails',
			status: 'ok'
		});
		expect(h.logLines().some((l) => JSON.stringify(l).includes('paul@test.local'))).toBe(false);
	});

	it('reads that application again without asking, once I allowed it', async () => {
		h.apisix.llm.script = modelUsing('search_emails', { from: 'anna@test.local' });
		const seen = requests().length;
		const answered = answers().length;
		const calls = h.apisix.llm.calls.length;
		await client.sendText(room, 'And what did Anna send me?');
		await nextAnswer(answered);
		expect(requests()).toHaveLength(seen);
		// The model of this turn reads, in its history, the call I allowed and what it returned
		const history = h.apisix.llm.calls[calls]?.request.messages ?? [];
		const replayed = history.find((m) =>
			(m.tool_calls ?? []).some(
				(c) => c.id.startsWith('replay_') && c.function.name === 'search_emails'
			)
		);
		expect(JSON.parse(replayed?.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({
			from: 'paul@test.local'
		});
		const result = history.find(
			(m) => m.role === 'tool' && m.tool_call_id === replayed?.tool_calls?.[0]?.id
		);
		expect(JSON.parse(result?.content ?? '{}')).toEqual({
			status: 200,
			body: { found: 'Budget from Paul' }
		});
		expect(h.apisix.contracts.calls.map((c) => c.query)).toEqual([{ from: 'anna@test.local' }]);
	});

	it('ignores a ✅ from someone else, on another message, or sent unencrypted from my account', async () => {
		const bob = await h.synapse.registerUser('bob');
		const bobClient = await startE2eeClient(h.synapse.url, bob);
		try {
			await h.synapse.request(
				alice,
				'POST',
				`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/invite`,
				{ user_id: bob.userId }
			);
			await bobClient.joinRoom(room);
			h.apisix.llm.script = modelUsing('search_files', { name: 'Q4 plan' });
			const seen = requests().length;
			await client.sendText(room, 'Find my Q4 plan');
			const request = await nextRequest(seen);
			// Bob, a member of the room, allows it. His first message shares his room key with the
			// assistant, which reads and ignores him: his ✅ then reaches it decrypted
			await bobClient.sendText(room, 'hi Jarvis');
			const loggedFor = async (msg: string): Promise<boolean> => {
				for (let i = 0; i < 120; i += 1) {
					if (h.logLines().some((l) => l['msg'] === msg && l['sender'] === bob.userId)) return true;
					await sleep(250);
				}
				return false;
			};
			expect(await loggedFor('assistant ignored a foreign sender')).toBe(true);
			await bobClient.react(room, request, '✅');
			expect(await loggedFor('answer ignored: not the owner')).toBe(true);
			// I react to the assistant's greeting instead of its question
			const greeting = client.messages.find(
				(m) => m.roomId === room && m.sender === assistantId && m.body.includes('Jarvis')
			);
			if (greeting === undefined) throw new Error('no greeting');
			await client.react(room, greeting.eventId, '✅');
			// A ✅ sent without encryption, as Twake Chat sends its reactions, or as a component on
			// the server could write it in my name
			await h.synapse.request(
				alice,
				'PUT',
				`/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.reaction/plain-${Date.now()}`,
				{ 'm.relates_to': { rel_type: 'm.annotation', event_id: request, key: '✅' } }
			);
			await sleep(3000);
			expect(h.apisix.contracts.calls).toHaveLength(0);
			// The question is still open: my own ✅ on it runs the call
			const answered = answers().length;
			await client.react(room, request, '✅');
			expect(await nextAnswer(answered)).toContain('Q4 plan.pdf');
			expect(h.apisix.contracts.calls.map((c) => c.query)).toEqual([{ name: 'Q4 plan' }]);
		} finally {
			await bobClient.stop();
		}
	});

	it('runs the call once when I answer twice', async () => {
		h.apisix.llm.script = modelUsing('list_my_tasks', { due: 'today' });
		const seen = requests().length;
		await client.sendText(room, 'What do I have to do today?');
		const request = await nextRequest(seen);
		const answered = answers().length;
		const first = await client.react(room, request, '✅');
		expect(await nextAnswer(answered)).toContain('Send the Q4 figures');
		// I take my ✅ back and give it again: the call was already decided
		await client.client.redactEvent(room, first);
		await client.react(room, request, '✅');
		await sleep(3000);
		expect(h.apisix.contracts.calls.map((c) => c.path)).toEqual(['/contracts/v1/tasks/mine']);
		expect(answers()).toHaveLength(answered + 1);
	});

	it('keeps a turn an event started from acting on its own, even once I allowed it to read: what it prepares then asks me', async () => {
		// The model reads the event, then the calendar it never read, and once allowed to, it
		// tries to accept the invitation on its own
		h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool' && last.name === 'read_event') {
				return {
					toolCalls: call('read_freebusy', {
						start: '2026-10-09T09:00:00+02:00',
						end: '2026-10-09T10:00:00+02:00'
					})
				};
			}
			if (last?.role === 'tool' && last.name === 'read_freebusy') {
				return { toolCalls: call('accept_invitation', { event_id: 'evt-9' }) };
			}
			if (last?.role === 'tool' && last.name === 'accept_invitation') {
				return { content: `Found: accepting said ${last.content ?? ''}` };
			}
			return { toolCalls: call('read_event', { event_id: 'evt-9' }) };
		};
		const seen = requests().length;
		const posted = await h.api.post('dispatcher', '/v1/events', {
			owner: 'alice@test.local',
			event_id: 'evt-9',
			type: 'calendar.invitation'
		});
		expect(posted.status).toBe(202);
		const request = await nextRequest(seen);
		const answered = answers().length;
		await client.react(room, request, '✅');
		// My yes let it read my calendar, nothing more: the acceptance it then prepares waits for
		// me in turn, and only its reads reached my calendar
		await nextRequest(seen + 1);
		expect(requests().at(-1)?.body).toContain('"event_id": "evt-9"');
		expect(answers()).toHaveLength(answered);
		expect(h.apisix.contracts.calls.map((c) => c.path)).toEqual([
			'/contracts/v1/events/evt-9',
			'/contracts/v1/calendar/freebusy'
		]);
	});

	it('keeps the call I allowed in our conversation even when the rest of the turn fails', async () => {
		// The model calls the contract; once the call I allowed came back, it fails to answer
		let failed = false;
		h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool' && last.name === 'list_rooms' && !failed) {
				failed = true;
				return { content: '' };
			}
			if (last?.role === 'user' && (last.content ?? '').startsWith('So')) {
				return { content: 'Found: from what we said' };
			}
			return { toolCalls: call('list_rooms', { limit: '5' }) };
		};
		const seen = requests().length;
		await client.sendText(room, 'Which rooms do I have?');
		const request = await nextRequest(seen);
		await client.react(room, request, '✅');
		await client.waitForMessage(room, assistantId, (t) => t.startsWith('Something went wrong'));
		expect(h.apisix.contracts.calls.map((c) => c.path)).toEqual(['/contracts/v1/chat/rooms']);
		// My next message: the model reads the call I allowed and what it returned
		const calls = h.apisix.llm.calls.length;
		const answered = answers().length;
		await client.sendText(room, 'So, which rooms?');
		await nextAnswer(answered);
		const history = h.apisix.llm.calls[calls]?.request.messages ?? [];
		const replayed = history.find((m) =>
			(m.tool_calls ?? []).some(
				(c) => c.id.startsWith('replay_') && c.function.name === 'list_rooms'
			)
		);
		const result = history.find(
			(m) => m.role === 'tool' && m.tool_call_id === replayed?.tool_calls?.[0]?.id
		);
		expect(JSON.parse(result?.content ?? '{}')).toEqual({
			status: 200,
			body: { found: 'Team room' }
		});
		expect(h.apisix.contracts.calls).toHaveLength(1);
	});

	it('runs only the contract I allowed, even when the catalog changed since', async () => {
		h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool' && last.name === 'search_contacts') {
				return { content: `Found: ${last.content ?? ''}` };
			}
			return { toolCalls: call('search_contacts', { q: 'Paul' }) };
		};
		const seen = requests().length;
		await client.sendText(room, "What is Paul's address?");
		const request = await nextRequest(seen);
		// Before I answer, the same tool comes to stand for another contract, of my mail
		const changed = structuredClone(CATALOG);
		changed.paths['/contracts/v1/contacts'].get.tags = ['mail.contacts.read.v1'];
		h.apisix.contracts.spec = changed;
		for (const app of h.apps) await app.agent.contracts.load();
		const answered = answers().length;
		await client.react(room, request, '✅');
		expect(await nextAnswer(answered)).toContain('contract_changed');
		expect(h.apisix.contracts.calls).toHaveLength(0);
		expect(
			h
				.logLines()
				.find((l) => l['msg'] === 'pending call replayed' && l['tool'] === 'search_contacts')
		).toMatchObject({ status: 'contract_changed' });
		h.apisix.contracts.spec = CATALOG;
		for (const app of h.apps) await app.agent.contracts.load();
	});

	it('gives every call of a model answer a result, when one of them waits for me', async () => {
		// Two calls in one answer: my notes, never read, and my mail, which I allowed above
		h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool') return { content: `Found: ${last.content ?? ''}` };
			return {
				toolCalls: [
					{
						id: 'both_notes',
						type: 'function',
						function: { name: 'search_notes', arguments: JSON.stringify({ q: 'budget' }) }
					},
					{
						id: 'both_emails',
						type: 'function',
						function: {
							name: 'search_emails',
							arguments: JSON.stringify({ from: 'paul@test.local' })
						}
					}
				]
			};
		};
		const seen = requests().length;
		await client.sendText(room, 'What do my notes and my mail say about the budget?');
		const request = await nextRequest(seen);
		const calls = h.apisix.llm.calls.length;
		const answered = answers().length;
		await client.react(room, request, '✅');
		await nextAnswer(answered);
		// The model of the resumed turn reads a result for every call it ever made
		const history = h.apisix.llm.calls[calls]?.request.messages ?? [];
		const answeredIds = history.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
		expect(answeredIds).toContain('both_notes');
		expect(answeredIds).toContain('both_emails');
	});

	it("lets me allow the calendar an invitation's check needs, then tells me about it", async () => {
		// The invitation arrives before I ever let the assistant read my calendar
		await withdrawConsent(h.db, 'alice@test.local', 'calendar', 'read');
		h.apisix.contracts.handler = (c) =>
			c.path.startsWith('/contracts/v1/events/')
				? {
						status: 200,
						body: invitationEvent({
							id: 'evt-pre',
							uid: 'uid-evt-pre',
							title: 'Budget review',
							start: '2026-10-09T09:00:00+02:00',
							end: '2026-10-09T10:00:00+02:00',
							timezone: 'Europe/Paris',
							organizer: 'bob@test.local',
							invitee: 'alice@test.local'
						})
					}
				: { status: 200, body: { start: '', end: '', free: true, busy: [] } };
		h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			return last?.role === 'tool' && last.name === 'read_freebusy'
				? { content: `Found: ${last.content ?? ''}` }
				: { content: 'Found: nothing' };
		};
		const seen = requests().length;
		const posted = await h.api.post('dispatcher', '/v1/events', {
			owner: 'alice@test.local',
			event_id: 'evt-pre',
			type: 'com.twake.calendar.event.invited.v1'
		});
		expect(posted.status).toBe(202);
		const request = await nextRequest(seen);
		expect(h.apisix.contracts.calls.map((c) => c.path)).toEqual(['/contracts/v1/events/evt-pre']);
		const answered = answers().length;
		await client.react(room, request, '✅');
		expect(await nextAnswer(answered)).toContain('"free":true');
		expect(h.apisix.contracts.calls.map((c) => c.path)).toEqual([
			'/contracts/v1/events/evt-pre',
			'/contracts/v1/calendar/freebusy'
		]);
		// The model went on from the invitation the harness had read
		const told = h.apisix.llm.calls.at(-1)?.request.messages ?? [];
		expect(told.some((m) => m.role === 'user' && (m.content ?? '').includes('evt-pre'))).toBe(true);
	});

	it('keeps a turn an event started from writing my assistant memory, even once I allowed it to read', async () => {
		// The invitation's own title told the model to remember to accept everything: it reads my
		// notes, which wait for me, and once I allowed them it tries to save that note
		await withdrawConsent(h.db, 'alice@test.local', 'notes', 'read');
		h.apisix.contracts.handler = (c) =>
			c.path.startsWith('/contracts/v1/events/')
				? {
						status: 200,
						body: invitationEvent({
							id: 'evt-note',
							uid: 'uid-evt-note',
							title: INJECTED_TITLE,
							start: '2026-10-09T14:00:00+02:00',
							end: '2026-10-09T15:00:00+02:00',
							timezone: 'Europe/Paris',
							organizer: 'mallory@test.local',
							invitee: 'alice@test.local'
						})
					}
				: c.path.endsWith('/freebusy')
					? { status: 200, body: { start: '', end: '', free: true, busy: [] } }
					: { status: 200, body: { found: 'Budget notes' } };
		h.apisix.llm.script = (request) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool' && last.name === 'search_notes') {
				return {
					toolCalls: call('memory', { action: 'add', target: 'memory', content: INJECTED_NOTE })
				};
			}
			if (last?.role === 'tool' && last.name === 'memory') {
				return { content: `Found: remembering said ${last.content ?? ''}` };
			}
			return { toolCalls: call('search_notes', { q: 'invitations' }) };
		};
		const seen = requests().length;
		const posted = await h.api.post('dispatcher', '/v1/events', {
			owner: 'alice@test.local',
			event_id: 'evt-note',
			type: 'com.twake.calendar.event.invited.v1'
		});
		expect(posted.status).toBe(202);
		const request = await nextRequest(seen);
		const answered = answers().length;
		await client.react(room, request, '✅');
		expect(await nextAnswer(answered)).toContain('needs_owner_approval');
		const kept = await h.api.get<{ memory: string[]; user: string[] }>(
			'alice@test.local',
			'/v1/memory'
		);
		expect(kept.body.memory).not.toContain(INJECTED_NOTE);
	});

	// A model that calls a tool, then takes its time to answer: with what the call found, or with
	// the answer given
	function slowModelUsing(tool: string, args: unknown, answer: string | null): LlmScript {
		return (request) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool' && last.name === tool) {
				return { content: answer ?? `Found: ${last.content ?? ''}`, delayMs: 3000 };
			}
			return { toolCalls: call(tool, args) };
		};
	}

	it('shows it is working on my ✅ to the request, then marks the request answered', async () => {
		await withdrawConsent(h.db, 'alice@test.local', 'drive', 'read');
		h.apisix.llm.script = slowModelUsing('search_files', { name: 'budget' }, null);
		const seen = requests().length;
		await client.sendText(room, 'Find my budget file');
		const request = await nextRequest(seen);
		const answered = answers().length;
		await client.react(room, request, '✅');
		// My reaction carries no reaction of its own: the eyes go on the request I answered
		const typing = eventually(() => feedback.isTyping(), 10_000);
		const eyes = await eventually(() => feedback.reactionsOn(request).find((r) => r.key === '👀'));
		expect(eyes).toBeDefined();
		expect(await typing).toBe(true);
		expect(await nextAnswer(answered)).toContain('Q4 plan.pdf');
		expect(await eventually(() => eyes !== undefined && feedback.isRedacted(eyes.eventId))).toBe(
			true
		);
		const check = await eventually(() => feedback.reactionsOn(request).find((r) => r.key === '✅'));
		expect(check).toBeDefined();
		expect(await eventually(async () => !(await feedback.isTyping()), 10_000)).toBe(true);
	});

	it('shows it is working on my yes in words, then marks my yes answered', async () => {
		await withdrawConsent(h.db, 'alice@test.local', 'tasks', 'read');
		h.apisix.llm.script = slowModelUsing('list_my_tasks', { due: 'today' }, null);
		const seen = requests().length;
		await client.sendText(room, 'What is due today?');
		await nextRequest(seen);
		const answered = answers().length;
		const yes = await client.sendText(room, 'yes');
		const typing = eventually(() => feedback.isTyping(), 10_000);
		const eyes = await eventually(() => feedback.reactionsOn(yes).find((r) => r.key === '👀'));
		expect(eyes).toBeDefined();
		expect(await typing).toBe(true);
		expect(await nextAnswer(answered)).toContain('Send the Q4 figures');
		expect(await eventually(() => eyes !== undefined && feedback.isRedacted(eyes.eventId))).toBe(
			true
		);
		const check = await eventually(() => feedback.reactionsOn(yes).find((r) => r.key === '✅'));
		expect(check).toBeDefined();
		expect(await eventually(async () => !(await feedback.isTyping()), 10_000)).toBe(true);
	});

	it('stops showing it is working on my answer when the turn it resumes fails', async () => {
		await withdrawConsent(h.db, 'alice@test.local', 'contacts', 'read');
		// Once the call I allowed came back, the model answers nothing
		h.apisix.llm.script = slowModelUsing('search_contacts', { q: 'Anna' }, '');
		const seen = requests().length;
		await client.sendText(room, "What is Anna's address?");
		const request = await nextRequest(seen);
		const failed = failures().length;
		await client.react(room, request, '✅');
		const typing = eventually(() => feedback.isTyping(), 10_000);
		const eyes = await eventually(() => feedback.reactionsOn(request).find((r) => r.key === '👀'));
		expect(eyes).toBeDefined();
		expect(await typing).toBe(true);
		expect(await eventually(() => failures().length > failed, 30_000)).toBe(true);
		expect(await eventually(() => eyes !== undefined && feedback.isRedacted(eyes.eventId))).toBe(
			true
		);
		expect(await eventually(async () => !(await feedback.isTyping()), 10_000)).toBe(true);
		await sleep(1000);
		expect(feedback.reactionsOn(request).filter((r) => r.key === '✅')).toEqual([]);
	});

	it('tells me what it did and what remains when my yes takes it past its limit of calls', async () => {
		await withdrawConsent(h.db, 'alice@test.local', 'notes', 'read');
		// One note at a time for as long as it has tools: the call I allow, the six my yes lets it
		// run, then one past that limit; asked without tools, it tells where it stands
		const progress = 'Found: I read 7 of your 10 notes, 3 remain. Ask me to continue.';
		let made = 0;
		h.apisix.llm.script = (request) => {
			if (request.tools === undefined) return { content: progress };
			made += 1;
			return {
				toolCalls: [
					{
						id: `note_${made}`,
						type: 'function',
						function: { name: 'search_notes', arguments: JSON.stringify({ q: `note ${made}` }) }
					}
				]
			};
		};
		const seen = requests().length;
		await client.sendText(room, 'Read my ten notes, one at a time');
		const request = await nextRequest(seen);
		const answered = answers().length;
		const failed = failures().length;
		await client.react(room, request, '✅');
		expect(await nextAnswer(answered)).toBe(progress);
		expect(failures()).toHaveLength(failed);
		expect(h.apisix.contracts.calls.map((c) => c.query)).toEqual(
			[1, 2, 3, 4, 5, 6, 7].map((n) => ({ q: `note ${n}` }))
		);
		expect(made).toBe(8);
	});
});

describe('my answer is admitted like any message', () => {
	let h: MatrixTestHarness;
	let alice: MatrixUser;
	let client: E2eeClient;
	let room: string;
	const assistantId = '@twake-space-assistant-alice:test.local';
	beforeAll(async () => {
		// One turn a minute: the question takes it, so the answer comes over the limit
		h = await startMatrixHarness({ env: { ADMISSION_USER_PER_MINUTE: '1' } });
		h.apisix.contracts.spec = CATALOG;
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(9);
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

	it('tells me it is busy when my answer comes over my limit, and runs nothing', async () => {
		h.apisix.contracts.calls.length = 0;
		h.apisix.llm.script = modelUsing('search_emails', { from: 'paul@test.local' });
		await client.sendText(room, 'What did Paul send me yesterday?');
		await client.waitForMessage(room, assistantId, (t) => t.startsWith('This is the first time'));
		const request = client.messages.find(
			(m) => m.roomId === room && m.body.startsWith('This is the first time')
		);
		if (request === undefined) throw new Error('no request');
		await client.react(room, request.eventId, '✅');
		await client.waitForMessage(room, assistantId, (t) => t.startsWith('I am busy right now'));
		expect(h.apisix.contracts.calls).toHaveLength(0);
	});
});
