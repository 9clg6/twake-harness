import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { dateIn, isoIn } from '../src/agent/clock.js';
import { withPrincipal } from '../src/db/client.js';
import { getMessages } from '../src/i18n/messages.js';
import { listActivitiesSince, purgeActivities } from '../src/journal/repository.js';
import { activityView } from '../src/journal/tool.js';
import {
	AVAILABILITY_REQUEST_TYPE,
	AVAILABILITY_SOURCE
} from '../src/suggestions/availability-journal.js';
import { startWorkerRole, type WorkerRole } from '../src/worker/role.js';
import {
	invitationId,
	lastUser,
	logSink,
	PREFIX,
	startActivityBroker,
	startCalendarFanout,
	turnCalls,
	whenListening,
	type CalendarFanout
} from './helpers/activity.js';
import { grantConsent } from './helpers/consents.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import {
	MEETING_CATALOG,
	toolsOf,
	type ChatRequest,
	type ContractCall,
	type ScriptedReply,
	type ToolCall
} from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import { startFakeSpace, type FakeSpace } from './helpers/space.js';
import type { MatrixUser } from './helpers/synapse.js';
import type { TestBroker } from './helpers/rabbitmq.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until<T>(
	what: string,
	read: () => T | null | undefined | false | Promise<T | null | undefined | false>,
	ms = 60_000
): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const found = await read();
		if (found !== null && found !== undefined && found !== false) return found;
		if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
		await sleep(250);
	}
}

// What the harness tells the invitee's assistant when their assistant had proposed this slot to the
// organizer's, in the language of the harness
const MENTION = getMessages('en').events.proposedSlot;

// A message the suggestion prefilter reads: a day, a time and a meeting
const ASKING = 'on se fait une réunion lundi à 8h ?';

// Where a turn an event woke names the invitation it was told of
const TOLD_OF_INVITATION = '[event] An invitation has been sent to me';

// The UID a suite scripts its acceptance model to prepare, set before it publishes
let acceptUid = '';

function toolCall(id: string, name: string, args: unknown): ToolCall {
	return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

// The day the model named, three days after the moment of its own prompt: read from the recorded
// call, never recomputed from the wall clock
function dayFromMoment(system: string, offsetDays: number): string {
	const iso = /ISO 8601: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})/.exec(system)?.[1];
	const base = iso === undefined ? new Date() : new Date(iso);
	return dateIn(new Date(base.getTime() + offsetDays * 86_400_000), 'Europe/Paris');
}

// A literal model: it proposes a meeting on the day the owner named, three days on, at ten in the
// morning, and says one line to the invitation it is told of
function proposingModel(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	if (last?.role === 'tool') return { content: 'NONE' };
	const system = request.messages[0]?.content ?? '';
	if (toolsOf(request).includes('propose_meeting')) {
		return {
			content: 'Vous avez un créneau.',
			toolCalls: [
				toolCall('call_propose', 'propose_meeting', {
					day: dayFromMoment(system, 3),
					time: '10:00',
					duration: 30,
					title: 'Point lundi'
				})
			]
		};
	}
	return { content: 'Je te le dis.' };
}

// A literal model for the invitation's own turn: told of it, it prepares its acceptance by its UID
// in the same answer, and once the acceptance ran it tells what came back
function acceptingModel(request: ChatRequest): ScriptedReply {
	const last = request.messages.at(-1);
	if (last?.role === 'tool' && last.name === 'accept_invitation') {
		return { content: `Accepted: ${last.content ?? ''}` };
	}
	if (lastUser(request).includes(TOLD_OF_INVITATION)) {
		return {
			content: 'Je l’accepte.',
			toolCalls: [toolCall('call_accept', 'accept_invitation', { body: { uid: acceptUid } })]
		};
	}
	return proposingModel(request);
}

// A direct conversation of two people, each with an assistant of their own, the second one's not
// invited yet
interface Conversation {
	readonly owner: MatrixUser;
	readonly other: MatrixUser;
	readonly ownerPrincipal: string;
	readonly inviteePrincipal: string;
	readonly ownerClient: E2eeClient;
	readonly inviteeClient: E2eeClient;
	readonly room: string;
	readonly assistant: string;
	listened(): Promise<number>;
	stop(): Promise<void>;
}

let h: MatrixTestHarness;
let space: FakeSpace;
let broker: TestBroker;
let calendar: CalendarFanout;
let worker: WorkerRole;
const logs = logSink();
const users = new Map<string, MatrixUser>();

// The invitee's listening journal, read under their own principal
function inviteeActivities(c: Conversation) {
	return withPrincipal(h.db, { id: c.inviteePrincipal }, (tx) =>
		listActivitiesSince(tx, c.inviteePrincipal, new Date(0))
	);
}

// The candidate slots the invitee's assistant answered the organizer with, oldest row first
async function answeredSlots(c: Conversation): Promise<string[]> {
	const rows = await inviteeActivities(c);
	const row = rows.find(
		(activity) => activity.source === AVAILABILITY_SOURCE && activity.outcome === 'answered'
	);
	if (row === undefined) return [];
	const view = activityView(row, 'Europe/Paris');
	const slots = view['slots'];
	return Array.isArray(slots)
		? slots.map((slot) => String((slot as Record<string, unknown>)['start']))
		: [];
}

// Registers a person, creates their assistant, keeps no room of its own with them, and lets it read
// their calendar, as the suggestion's owners do
async function becomeAssistantOwner(localpart: string): Promise<MatrixUser> {
	const user = await h.synapse.registerUser(localpart);
	users.set(localpart, user);
	const principal = `${localpart}@test.local`;
	const created = await h.api.post(principal, '/v1/assistants', { name: `Assistant ${localpart}` });
	expect(created.status).toBe(201);
	// The assistants table is the owner's alone to write, under their principal
	await withPrincipal(
		h.db,
		{ id: principal },
		(tx) => tx.sql`update assistants set room_id = null where owner = ${principal}`
	);
	await grantConsent(h.db, principal, 'calendar', 'read');
	return user;
}

// An encrypted direct conversation of two people, each with their own assistant
async function encryptedConversation(): Promise<Conversation> {
	const tag = Math.random().toString(36).slice(2, 7);
	const owner = await becomeAssistantOwner(`o${tag}`);
	const other = await becomeAssistantOwner(`t${tag}`);
	const ownerClient = await startE2eeClient(h.synapse.url, owner);
	const inviteeClient = await startE2eeClient(h.synapse.url, other);
	const room = await ownerClient.createDirectRoom(other.userId);
	await inviteeClient.joinRoom(room);
	const ownerPrincipal = `o${tag}@test.local`;
	const inviteePrincipal = `t${tag}@test.local`;
	const rows = await withPrincipal(
		h.db,
		{ id: ownerPrincipal },
		(tx) =>
			tx.sql<{ user_id: string }[]>`select user_id from assistants where owner = ${ownerPrincipal}`
	);
	const assistant = rows[0]?.user_id ?? '';
	return {
		owner,
		other,
		ownerPrincipal,
		inviteePrincipal,
		ownerClient,
		inviteeClient,
		room,
		assistant,
		listened: async () =>
			(await h.db.sql`select 1 from assistant_listened_rooms where room_id = ${room}`).length,
		stop: async () => {
			await ownerClient.stop();
			await inviteeClient.stop();
		}
	};
}

// The conversation once the invitee said yes and the owner invited their assistant in
async function listenedConversation(): Promise<Conversation> {
	const c = await encryptedConversation();
	await c.ownerClient.client.sendStateEvent(
		c.room,
		'app.twake.chat.assistant_request',
		c.owner.userId,
		{
			assistant_id: c.assistant,
			requested: true,
			ts: Date.now()
		}
	);
	await c.inviteeClient.client.sendStateEvent(
		c.room,
		'app.twake.chat.assistant_consent',
		c.other.userId,
		{
			assistant_id: c.assistant,
			accepted: true,
			ts: Date.now()
		}
	);
	await c.ownerClient.client.inviteUser(c.assistant, c.room);
	await until('the listener read the conversation', async () =>
		(await c.listened()) === 1 ? true : null
	);
	return c;
}

// The invitee's own assistant room, restored where the suite cleared it: their assistant must have a
// room of its own to answer the organizer's request and to be woken by the invitation
async function inviteeAssistant(c: Conversation): Promise<void> {
	const rows = await h.db.sql<{ room_id: string }[]>`
		select room_id from assistant_rooms where owner = ${c.inviteePrincipal} limit 1`;
	const room = rows[0]?.room_id ?? '';
	await withPrincipal(
		h.db,
		{ id: c.inviteePrincipal },
		(tx) => tx.sql`update assistants set room_id = ${room} where owner = ${c.inviteePrincipal}`
	);
}

// The fake gateway's calendar, as the two assistants read it: the invitee's own free/busy and the
// slots it answers, told apart by the owner each read is made on behalf of. Everyone is free
// everywhere and no slot search finds anything, so the one candidate is the time that was asked.
function availabilityHandler(): (call: ContractCall) => { status: number; body: unknown } {
	return (call) => {
		if (call.path.endsWith('/freebusy')) {
			return { status: 200, body: { start: '', end: '', free: true, busy: [] } };
		}
		if (call.path.endsWith('/availability/slots')) {
			return { status: 200, body: { slots: [] } };
		}
		return {
			status: 200,
			body: call.method === 'POST' ? { uid: 'm-e1', partstat: 'ACCEPTED' } : { ok: true }
		};
	};
}

function vcalendar(...lines: readonly string[]): string {
	return `${['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n')}\r\n`;
}

// A wall time as the calendar writes it, "20261015T100000", from the instant it names in Paris
function wallOf(instant: Date): string {
	const iso = isoIn(instant, 'Europe/Paris');
	const [day = '', time = ''] = iso.split('T');
	return `${day.replace(/-/g, '')}T${time.slice(0, 8).replace(/:/g, '')}`;
}

interface InvitationOptions {
	readonly uid: string;
	readonly recipient: string;
	readonly organizer: string;
	readonly start: string;
	readonly end: string;
}

// A new invitation as Calendar's side service publishes it, one per invitee
function invitation(options: InvitationOptions): Record<string, unknown> {
	return {
		senderEmail: options.organizer,
		recipientEmail: options.recipient,
		method: 'REQUEST',
		event: vcalendar(
			'BEGIN:VEVENT',
			`UID:${options.uid}`,
			'SUMMARY:Point',
			`DTSTART;TZID=Europe/Paris:${options.start}`,
			`DTEND;TZID=Europe/Paris:${options.end}`,
			`ORGANIZER;CN=Organizer:mailto:${options.organizer}`,
			'DTSTAMP:20261005T091422Z',
			'END:VEVENT'
		),
		eventPath: `/calendars/a/b/${options.uid}.ics`,
		isNewEvent: true
	};
}

// Publishes an invitation on Calendar's fanout and gives the id its invitee's turn is told of
async function invite(options: InvitationOptions): Promise<string> {
	await calendar.publish(invitation(options));
	return invitationId(options.uid, options.recipient);
}

// What the invitee's assistant was first told of the invitation of this id, once its turn came
async function toldOf(id: string): Promise<string> {
	await until('the invitation woke a turn', () => turnCalls(h.apisix.llm.calls, id).length >= 1);
	return lastUser(turnCalls(h.apisix.llm.calls, id)[0]?.request);
}

// What reached the applications other than reads
function writes(): ContractCall[] {
	return h.apisix.contracts.calls.filter((call) => call.method !== 'GET');
}

beforeAll(async () => {
	space = await startFakeSpace();
	broker = await startActivityBroker();
	calendar = await startCalendarFanout(broker);
	h = await startMatrixHarness({
		env: {
			SUGGESTIONS_ENABLED: 'true',
			SPACE_API_URL: space.url,
			SPACE_API_TOKEN: 'tws_secret',
			ASSISTANT_TIMEZONE: 'Europe/Paris',
			...calendar.settings,
			RABBITMQ_PREFIX: PREFIX,
			ADMISSION_USER_PER_MINUTE: '100',
			WAKEUPS_PER_HOUR: '1000'
		}
	});
	h.apisix.contracts.spec = MEETING_CATALOG;
	for (const app of h.apps) expect(await app.agent.contracts.load()).toBeGreaterThan(0);
	h.apisix.llm.script = proposingModel;
	// The worker role listens to Calendar's fanout; the api replicas' turn workers run the jobs
	worker = await whenListening(
		await startWorkerRole({
			config: { ...h.config, role: 'worker' },
			db: h.db,
			logStream: logs.stream
		})
	);
}, 300_000);

afterAll(async () => {
	if (worker !== undefined) await worker.stop();
	if (h !== undefined) await h.close();
	if (broker !== undefined) await broker.stop();
	if (space !== undefined) await space.close();
});

afterEach(() => {
	acceptUid = '';
	h.apisix.llm.script = proposingModel;
	h.apisix.contracts.handler = availabilityHandler();
});

describe('an invitation mentions the slot my assistant had proposed', () => {
	// The request played in the listened conversation, then the one candidate slot the invitee's
	// assistant answered with, which the invitation is built on
	async function proposedSlot(c: Conversation): Promise<Date> {
		await inviteeAssistant(c);
		// The invitee lets their assistant share their availability with colleagues
		await grantConsent(h.db, c.inviteePrincipal, 'availability', 'read');
		h.apisix.contracts.handler = availabilityHandler();
		await c.inviteeClient.sendText(c.room, ASKING);
		const slots = await until('the invitee answered the request', async () => {
			const found = await answeredSlots(c);
			return found.length > 0 ? found : null;
		});
		const start = slots[0];
		if (start === undefined) throw new Error('no candidate slot');
		return new Date(Date.parse(start));
	}

	it('says so to the invitee when the organizer invites them to the very slot their assistant proposed', async () => {
		const c = await listenedConversation();
		try {
			const slot = await proposedSlot(c);
			const id = await invite({
				uid: 'uid-mention',
				recipient: c.inviteePrincipal,
				organizer: c.ownerPrincipal,
				start: wallOf(slot),
				end: wallOf(new Date(slot.getTime() + 30 * 60_000))
			});
			// The invitation's turn was told the slot my assistant had proposed to its organizer
			expect(await toldOf(id)).toContain(MENTION);
		} finally {
			await c.stop();
		}
	}, 180_000);

	it('adds nothing for an invitation at another time, nor from another organizer', async () => {
		const c = await listenedConversation();
		try {
			const slot = await proposedSlot(c);
			const elsewhere = await invite({
				uid: 'uid-elsewhere',
				recipient: c.inviteePrincipal,
				organizer: c.ownerPrincipal,
				start: wallOf(new Date(slot.getTime() + 3_600_000)),
				end: wallOf(new Date(slot.getTime() + 5_400_000))
			});
			expect(await toldOf(elsewhere)).not.toContain(MENTION);
			const stranger = await invite({
				uid: 'uid-stranger',
				recipient: c.inviteePrincipal,
				organizer: 'someone@test.local',
				start: wallOf(slot),
				end: wallOf(new Date(slot.getTime() + 30 * 60_000))
			});
			expect(await toldOf(stranger)).not.toContain(MENTION);
		} finally {
			await c.stop();
		}
	}, 180_000);

	it('adds nothing once the display fields of the journal are erased', async () => {
		const c = await listenedConversation();
		try {
			const slot = await proposedSlot(c);
			// The purge erases the names of every activity, as it does after a week
			await withPrincipal(h.db, { id: c.inviteePrincipal }, (tx) =>
				purgeActivities(tx, c.inviteePrincipal, {
					names: new Date(Date.now() + 60_000),
					rows: new Date(0)
				})
			);
			const id = await invite({
				uid: 'uid-erased',
				recipient: c.inviteePrincipal,
				organizer: c.ownerPrincipal,
				start: wallOf(slot),
				end: wallOf(new Date(slot.getTime() + 30 * 60_000))
			});
			expect(await toldOf(id)).not.toContain(MENTION);
		} finally {
			await c.stop();
		}
	}, 180_000);

	it('never accepts the invitation in place of the invitee', async () => {
		const c = await listenedConversation();
		try {
			await inviteeAssistant(c);
			// The invitee lets their assistant write in their calendar, as the pilot's owners do
			await grantConsent(h.db, c.inviteePrincipal, 'calendar', 'write');
			acceptUid = 'uid-accept';
			h.apisix.llm.script = acceptingModel;
			h.apisix.contracts.handler = availabilityHandler();
			const id = await invite({
				uid: 'uid-accept',
				recipient: c.inviteePrincipal,
				organizer: c.ownerPrincipal,
				start: '20261015T100000',
				end: '20261015T103000'
			});
			await toldOf(id);
			// The turn ends on the harness's question: the acceptance it prepared waits for the invitee,
			// the harness says so, and nothing reached their calendar
			const wait = await until('the acceptance waited for its owner', () => {
				const found = h
					.logLines()
					.filter(
						(line) =>
							line['msg'] === 'contract call waits for its owner' &&
							line['tool'] === 'accept_invitation'
					)
					.at(-1);
				return found === undefined ? null : found;
			});
			expect(wait).toMatchObject({ tool: 'accept_invitation' });
			expect(writes()).toHaveLength(0);
		} finally {
			await c.stop();
		}
	}, 180_000);
});

// The journal row the invitee's assistant leaves for the request, in the source and type of the
// harness's own, which the invitation's mention reads
it('keeps the answered request in the invitee’s journal under the harness’s own source', async () => {
	const c = await listenedConversation();
	try {
		await inviteeAssistant(c);
		await grantConsent(h.db, c.inviteePrincipal, 'availability', 'read');
		h.apisix.contracts.handler = availabilityHandler();
		await c.inviteeClient.sendText(c.room, ASKING);
		const rows = await until('the journal row', async () => {
			const found = (await inviteeActivities(c)).filter(
				(activity) => activity.source === AVAILABILITY_SOURCE
			);
			return found.length > 0 ? found : null;
		});
		expect(rows[0]?.type).toBe(AVAILABILITY_REQUEST_TYPE);
		expect(rows[0]?.outcome).toBe('answered');
	} finally {
		await c.stop();
	}
}, 180_000);
