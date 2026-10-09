import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

import { localeOf } from '../assistants/locale.js';
import { findAssistant } from '../assistants/repository.js';
import { briefId } from '../briefs/schedule.js';
import { endBriefWait, findBriefWait, keepBriefWait } from '../briefs/waits.js';
import type { Config } from '../config.js';
import type { ConsentMetrics } from '../consents/metrics.js';
import {
	approvePendingCall,
	markReplayed,
	supersedeApprovedCall,
	type ApprovedCall,
	type ClosedRequest
} from '../consents/repository.js';
import { withPrincipal, type Db, type Tx } from '../db/client.js';
import { getMessages, type Locale, type Messages } from '../i18n/messages.js';
import { LlmError, type LlmClient, type LlmMessage } from '../llm/client.js';
import { fenced } from '../llm/data.js';
import { escapeHtml, renderQuotedMarkdown } from '../matrix/format.js';
import type { Principal } from '../principals/principal.js';
import { ensurePrincipal } from '../principals/repository.js';
import {
	ensureRoomSession,
	saveSessionMessages,
	type SessionRecord
} from '../sessions/repository.js';
import { fetchOwnerTimeZone } from '../settings/time-zone.js';
import { spentForTheDay, type Admission, type Refusal, type SpentReason } from './admission.js';
import { withoutCallMarkup } from './call-markup.js';
import { describeMoment, type Clock } from './clock.js';
import type { TurnGate } from './gate.js';
import { buildSystemPrompt } from './prompt.js';
import { runTool, type ToolContext, type ToolOutcome, type ToolRegistry } from './tools.js';

// The calendar's operation the brief reads the day and the invitations of, and the most meetings it
// reads of the day
const LIST_EVENTS = 'list_calendar_events';
const MAX_MEETINGS = 20;

// The invitations that wait for the owner's answer, over seven days from the brief's: the read gives
// each occurrence, a hundred at most, the most the contract gives, and the model is handed twenty
// invitations at most once each series is one
const INVITATION_DAYS = 7;
const MAX_PENDING_OCCURRENCES = 100;
const MAX_INVITATIONS = 20;

// The tasks' operation the brief reads the owner's late tasks and those of the day with, and the
// most tasks the model is handed, late ones first
const LIST_TASKS = 'list_my_tasks';
const MAX_TASKS = 30;

// What the brief's reads hand the model, as the invitation check's reads do
const BRIEF_DATA = 'brief-data';

// What the conversation keeps of a brief for the owner's next turns, as data: what its numbers and
// its tasks' keys name, until a newer brief replaces it. The line that introduces it goes with it.
const BRIEF_REFERENCES = 'brief-references';
const KEPT_REFERENCES = new RegExp(
	`\\n[^\\n]*\\n<<<${BRIEF_REFERENCES} ([0-9a-f]{12})\\n[^\\n]*\\n${BRIEF_REFERENCES} \\1>>>`,
	'g'
);

// How many items each section of the brief shows at most
const SHOWN = 5;

// One meeting of the day as the calendar's contract lists it: what the contract computed, its
// overlaps with the owner's other meetings included, then, under untrusted, what people wrote
const meetingSchema = z.object({
	uid: z.string(),
	recurrence_id: z.string().nullable(),
	start: z.string(),
	end: z.string(),
	all_day: z.boolean(),
	status: z.string().nullable(),
	private: z.boolean(),
	my_partstat: z.string().nullable(),
	needs_action: z.boolean(),
	conflicts: z.array(z.object({ uid: z.string(), recurrence_id: z.string().nullable() })),
	untrusted: z.object({
		title: z.string().nullable(),
		location: z.string().nullable(),
		description: z.string().nullable(),
		organizer: z.string().nullable()
	})
});

type Meeting = z.infer<typeof meetingSchema>;

// What the calendar's contract lists over days, in the order its occurrences start
const listSchema = z.object({
	time_zone: z.string().nullable(),
	events: z.array(meetingSchema),
	truncated: z.boolean()
});

// The owner's day as the brief tells it: their meetings, in order, at most twenty, and whether the
// calendar had more
interface Day {
	readonly time_zone: string | null;
	readonly meetings: readonly Meeting[];
	readonly truncated: boolean;
}

// An invitation that waits for the owner's answer, as the brief tells it once, by its number: its
// first occurrence over the days read, and whether it is one of a series
type Invitation = { readonly number: number; readonly series: boolean } & Meeting;

// The invitations that wait for the owner's answer, numbered from 1 in the order they start, and
// whether the calendar had more
interface Invitations {
	readonly pending: readonly Invitation[];
	readonly truncated: boolean;
}

// What a brief's numbers and its tasks' keys name, for the owner's next turns: the uid and
// occurrence of each invitation, the ids of each task
interface References {
	readonly invitations?: readonly {
		readonly number: number;
		readonly uid: string;
		readonly recurrence_id: string | null;
	}[];
	readonly tasks?: readonly {
		readonly key: string;
		readonly board_id: string;
		readonly task_id: string;
	}[];
}

// One open task as the tasks' contract lists it: what Tasks computed, then, under untrusted, what
// members wrote
const taskSchema = z.object({
	board_id: z.string(),
	task_id: z.string(),
	key: z.string(),
	parent_id: z.string().nullable(),
	section_id: z.string().nullable(),
	state: z.string(),
	priority: z.number().nullable(),
	due_date: z.string().nullable(),
	due_time: z.string().nullable(),
	due_zone: z.string().nullable(),
	deadline: z.string().nullable(),
	assignees: z.array(z.string()),
	assigned_to_me: z.boolean().nullable(),
	untrusted: z.object({
		title: z.string(),
		board_name: z.string(),
		labels: z.array(z.string())
	})
});

type Task = z.infer<typeof taskSchema>;

const taskListSchema = z.object({ tasks: z.array(taskSchema), truncated: z.boolean() });

// The owner's open tasks due before the day of the brief, then those due that day, thirty at most
// together, and whether Tasks had more
interface Tasks {
	readonly overdue: readonly Task[];
	readonly today: readonly Task[];
	readonly truncated: boolean;
}

// The harness's question about the owner's permission for their assistant to act for them, which
// the platform's broker holds none of, or an expired one: its text, and the call it froze, which
// waits for their answer
interface DelegationQuestion {
	readonly text: string;
	readonly pendingCallId: string;
}

// A read of the brief, or why there is none: an application that needs a yes the owner did not
// give, here or on the platform, is not read, and nobody asks them for it. The day's read the
// platform's broker refused for want of their permission is the exception, while no brief waits
// for their answer about it: its call waits for them, under the harness's question.
type Read<T> =
	| { readonly ok: true; readonly value: T }
	| {
			readonly ok: false;
			readonly reason: string;
			readonly status?: number;
			readonly question?: DelegationQuestion;
	  };

// What the brief tells, section by section, as its reads gave it
interface Sections {
	readonly calendar: Read<Day>;
	readonly invitations: Read<Invitations>;
	readonly tasks: Read<Tasks>;
}

// The application each section of the brief reads, which the line of a section not read names
const DOMAINS: Readonly<Record<keyof Sections, string>> = {
	calendar: 'calendar',
	invitations: 'calendar',
	tasks: 'tasks'
};

export interface BriefInput {
	readonly principal: Principal;
	readonly roomId: string;
	// What the owner's assistant is told their day starts with, as its wake-up wrote it
	readonly told: string;
	// The date, in the owner's zone, the brief is of
	readonly date: string;
	readonly log: FastifyBaseLogger;
	// What links the brief's reads in the audit: the brief's own id
	readonly correlationId: string;
	// The name the owner gave the assistant, when there is one
	readonly assistantName?: string;
}

// The owner's yes to the question a brief gave way to, once they gave the platform their permission
export interface BriefResumeInput {
	readonly principal: Principal;
	readonly roomId: string;
	// The call the brief's read froze, which their yes allowed
	readonly pendingCallId: string;
	readonly log: FastifyBaseLogger;
	// The name the owner gave the assistant, when there is one
	readonly assistantName?: string;
}

export type BriefResult =
	// The brief of its date, as the model wrote it, or as the harness lays it out when the model
	// wrote nothing, and its HTML, which the harness lays out either way. Refused by admission once
	// the owner's day, or the share of it their assistant spends on its own, was spent, the harness
	// lays it out with no model call, and says why.
	| {
			readonly kind: 'ok';
			readonly text: string;
			readonly html: string;
			readonly date: string;
			readonly refusedFor?: SpentReason;
	  }
	// The broker refused the day's read for want of the owner's permission: the brief gives way to
	// the harness's question about it, whose call waits for their answer
	| { readonly kind: 'question'; readonly text: string; readonly pendingCallId: string }
	// The broker still refuses the read, and a brief waits for the owner's answer to the question it
	// gave way to: this one says nothing
	| { readonly kind: 'withheld' }
	| { readonly kind: 'forbidden' }
	| { readonly kind: 'missing' }
	// Admission refused it for another reason, as it would a turn
	| ({ readonly kind: 'busy' } & Refusal);

export interface BriefRunnerDeps {
	readonly config: Config;
	readonly db: Db;
	readonly llm: LlmClient;
	readonly tools: ToolRegistry;
	readonly admission: Admission;
	readonly gate: TurnGate;
	readonly clock: Clock;
	// Where the role counts the requests a brief that goes out closes unanswered
	readonly consentMetrics: ConsentMetrics;
	// The assistant's persona, as its owner's turns give it, in its owner's language
	persona(assistantName: string | undefined, messages: Messages): string;
	// Runs a call its owner allowed as it was frozen, as their yes runs any
	runFrozenCall(
		approved: ApprovedCall,
		pendingCallId: string,
		context: ToolContext,
		log: FastifyBaseLogger
	): Promise<ToolOutcome>;
}

export interface BriefRunner {
	run(input: BriefInput): Promise<BriefResult>;
	// The brief that gave way to the question about the owner's permission, which their yes resumes:
	// that day's brief, whenever they said it
	resume(input: BriefResumeInput): Promise<BriefResult>;
}

// A brief being written: its owner, their conversation in the room and their language, what their
// assistant is told their day starts with, the date it is of, and the spent day admission refused
// it for, when it did: the harness lays it out then, with no model call
interface Writing {
	readonly principal: Principal;
	readonly session: SessionRecord;
	readonly locale: Locale;
	readonly told: string;
	readonly date: string;
	readonly assistantName: string | undefined;
	readonly log: FastifyBaseLogger;
	readonly refusedFor: SpentReason | null;
}

// The wall time of a time the calendar gave in its day's zone, with that zone's offset: 09:00
function wallTimeOf(time: string): string {
	return /T(\d{2}:\d{2})/.exec(time)?.[1] ?? time;
}

// The hours of a meeting that is not a whole day's, as its calendar's zone gives them: 09:00–09:30
function hoursOf(meeting: Meeting): string {
	return `${wallTimeOf(meeting.start)}–${wallTimeOf(meeting.end)}`;
}

// A date of the days around the brief in words, as the owner reads it: "jeudi 22 octobre"
function dayWords(date: string, locale: Locale): string {
	return new Intl.DateTimeFormat(locale, {
		timeZone: 'UTC',
		weekday: 'long',
		day: 'numeric',
		month: 'long'
	}).format(new Date(`${date.slice(0, 10)}T12:00:00Z`));
}

// Text the harness lays out, and its HTML
interface Laid {
	readonly text: string;
	readonly html: string;
}

function line(text: string): Laid {
	return { text, html: `<p>${escapeHtml(text)}</p>` };
}

// A section of the brief as the harness lays it out: its heading over its first items, numbered
// from 1 or not, then how many more there are, if any. People's text is text, never markup.
function section(
	heading: string,
	items: readonly string[],
	more: string | null,
	numbered: boolean
): Laid {
	const list = numbered ? 'ol' : 'ul';
	const shown = items.slice(0, SHOWN);
	const after = more === null ? [] : [more];
	return {
		text: [
			heading,
			...shown.map((item, index) => `${numbered ? `${index + 1}.` : '-'} ${item}`),
			...after
		].join('\n'),
		html: [
			`<p>${escapeHtml(heading)}</p>`,
			`<${list}>${shown.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${list}>`,
			...after.map((text) => `<p>${escapeHtml(text)}</p>`)
		].join('\n')
	};
}

// What a section says of the items it does not show, of those its application gave, or nothing
function moreOf(
	count: number,
	truncated: boolean,
	words: Messages['brief']['template']
): string | null {
	const hidden = Math.max(count - SHOWN, 0);
	return hidden > 0 || truncated ? words.more(hidden, truncated) : null;
}

// The day's meetings, each one with its times and title, and the titles of those it overlaps that
// the day lists
function meetingLines(
	meetings: readonly Meeting[],
	words: Messages['brief']['template']
): readonly string[] {
	const titleOf = (meeting: Meeting): string => meeting.untrusted.title ?? words.untitled;
	return meetings.map((meeting) => {
		const title = titleOf(meeting);
		const overlapped = meeting.conflicts.flatMap((conflict) =>
			meetings.filter(
				(other) => other.uid === conflict.uid && other.recurrence_id === conflict.recurrence_id
			)
		);
		const overlaps =
			meeting.conflicts.length === 0 ? '' : ` (${words.overlaps(overlapped.map(titleOf))})`;
		return meeting.all_day
			? `${words.allDay(title)}${overlaps}`
			: `${hoursOf(meeting)} ${title}${overlaps}`;
	});
}

// The brief as the harness lays it out itself, for the owner, when the model wrote nothing: the
// sections the model is asked for, five items at most each, an empty one left out but for the day,
// which says in one line that it has no meeting, an application not read said once, and examples of
// what to answer that fit what the brief shows
function template(
	sections: Sections,
	date: string,
	locale: Locale,
	words: Messages['brief']['template']
): Laid {
	const { calendar, invitations, tasks } = sections;
	const laid: Laid[] = [];
	const examples: string[] = [];
	const unread = new Set<string>();
	const notRead = (name: keyof Sections): void => {
		if (unread.has(DOMAINS[name])) return;
		unread.add(DOMAINS[name]);
		laid.push(line(words.notRead[name]));
	};
	// Its date in words: the brief's own, whatever day it goes out on
	const dateWords = describeMoment(new Date(`${date}T12:00:00Z`), 'UTC', locale).date;
	if (!calendar.ok) notRead('calendar');
	else if (calendar.value.meetings.length === 0) laid.push(line(words.none(dateWords)));
	else {
		const { meetings, truncated } = calendar.value;
		laid.push(
			section(
				words.heading(dateWords),
				meetingLines(meetings, words),
				moreOf(meetings.length, truncated, words),
				false
			)
		);
	}
	if (!invitations.ok) notRead('invitations');
	else {
		const { pending, truncated } = invitations.value;
		const first = pending[0];
		if (first !== undefined) {
			// The invitations shown are the first ones, whose numbers count from 1
			const lines = pending.map((invitation) =>
				words.invitation(
					invitation.untrusted.title ?? words.untitled,
					dayWords(invitation.start, locale),
					invitation.all_day ? null : hoursOf(invitation),
					invitation.series,
					invitation.untrusted.organizer
				)
			);
			laid.push(
				section(
					words.invitations(INVITATION_DAYS),
					lines,
					moreOf(pending.length, truncated, words),
					true
				)
			);
			examples.push(words.decline(first.number));
		}
	}
	if (!tasks.ok) notRead('tasks');
	else {
		const { overdue, today, truncated } = tasks.value;
		const first = overdue[0] ?? today[0];
		if (first !== undefined) {
			const lines = [
				...overdue.map((task) =>
					words.late(
						task.key,
						task.untrusted.title,
						task.due_date === null ? null : dayWords(task.due_date, locale)
					)
				),
				...today.map((task) => words.dueToday(task.key, task.untrusted.title, task.due_time))
			];
			laid.push(section(words.tasks, lines, moreOf(lines.length, truncated, words), false));
			examples.push(words.postpone(first.key));
		}
	}
	if (examples.length > 0) laid.push(line(words.footer(examples)));
	return {
		text: laid.map((part) => part.text).join('\n\n'),
		html: laid.map((part) => part.html).join('\n')
	};
}

// The status a contract answered a call with, and its body, when it answered
function answerOf(result: unknown): { readonly status: number; readonly body: unknown } | null {
	if (typeof result !== 'object' || result === null) return null;
	const { status, body } = result as Record<string, unknown>;
	return typeof status === 'number' ? { status, body } : null;
}

// Why a call that would have waited for its owner was not made, as the contract tool tells a turn
// nobody attends
function notAskedReason(result: unknown): string | null {
	if (typeof result !== 'object' || result === null) return null;
	const { status, reasons } = result as Record<string, unknown>;
	return status === 'not_asked' && Array.isArray(reasons) ? reasons.join(',') : null;
}

// What a read of the brief came to, as the contract tool ran it
function readOf<T>({ result, final, pendingCallId }: ToolOutcome, schema: z.ZodType<T>): Read<T> {
	if (final !== undefined && pendingCallId !== undefined) {
		return { ok: false, reason: 'delegation', question: { text: final, pendingCallId } };
	}
	const reason = notAskedReason(result);
	if (reason !== null) return { ok: false, reason };
	const answer = answerOf(result);
	if (answer === null || answer.status < 200 || answer.status >= 300) {
		return { ok: false, reason: 'failed', ...(answer === null ? {} : { status: answer.status }) };
	}
	const parsed = schema.safeParse(answer.body);
	if (!parsed.success) return { ok: false, reason: 'unreadable', status: answer.status };
	return { ok: true, value: parsed.data };
}

// The owner's day as the brief tells it, from the calendar's list of it
function dayOf(list: Read<z.infer<typeof listSchema>>): Read<Day> {
	if (!list.ok) return list;
	const { time_zone, events, truncated } = list.value;
	return {
		ok: true,
		value: {
			time_zone,
			meetings: events.slice(0, MAX_MEETINGS),
			truncated: truncated || events.length > MAX_MEETINGS
		}
	};
}

// The invitations that wait for the owner's answer, from the occurrences the calendar listed in the
// order they start: each series once, by its first occurrence over the days read, numbered from 1
function invitationsOf(events: readonly Meeting[], truncated: boolean): Invitations {
	const seen = new Set<string>();
	const firsts = events.filter((event) => {
		if (!event.needs_action || seen.has(event.uid)) return false;
		seen.add(event.uid);
		return true;
	});
	return {
		pending: firsts.slice(0, MAX_INVITATIONS).map((event, index) => ({
			number: index + 1,
			series: event.recurrence_id !== null,
			...event
		})),
		truncated: truncated || firsts.length > MAX_INVITATIONS
	};
}

// What the brief's numbers and its tasks' keys name, or null when it names nothing
function referencesOf(sections: Sections): References | null {
	const { invitations, tasks } = sections;
	const numbered = invitations.ok ? invitations.value.pending : [];
	const keyed = tasks.ok ? [...tasks.value.overdue, ...tasks.value.today] : [];
	if (numbered.length + keyed.length === 0) return null;
	return {
		...(numbered.length === 0
			? {}
			: {
					invitations: numbered.map(({ number, uid, recurrence_id }) => ({
						number,
						uid,
						recurrence_id
					}))
				}),
		...(keyed.length === 0
			? {}
			: { tasks: keyed.map(({ key, board_id, task_id }) => ({ key, board_id, task_id })) })
	};
}

// A message of the conversation without the references an earlier brief left in it
function withoutReferences(message: LlmMessage): LlmMessage {
	return message.role === 'user' && message.content !== null
		? { ...message, content: message.content.replace(KEPT_REFERENCES, '') }
		: message;
}

// Each section of the brief with its read, in the order the brief tells them
function readsOf(sections: Sections): readonly (readonly [keyof Sections, Read<unknown>])[] {
	return Object.entries(sections) as [keyof Sections, Read<unknown>][];
}

// What the model is handed of the brief's reads: each section read, and why each other one was not
function dataOf(date: string, sections: Sections): Record<string, unknown> {
	const data: Record<string, unknown> = { date };
	const notRead: Record<string, string> = {};
	for (const [name, read] of readsOf(sections)) {
		if (read.ok) data[name] = read.value;
		else notRead[name] = read.reason;
	}
	return Object.keys(notRead).length === 0 ? data : { ...data, not_read: notRead };
}

// The line that says the brief goes without a section's read, and why
function logSkipped(name: keyof Sections, read: Read<unknown>, log: FastifyBaseLogger): void {
	if (read.ok) return;
	log.info(
		{
			domain: DOMAINS[name],
			section: name,
			reason: read.reason,
			...(read.status === undefined ? {} : { status: read.status })
		},
		'brief application skipped'
	);
}

// The brief of an owner's working day, which the worker role's scheduler asks their assistant for.
// Admitted as a turn is, it reads the day's meetings of their calendar, the invitations that wait
// for their answer and their late tasks and those of the day itself, through the same tools and
// checks as the model's calls, with nobody to ask: an application they did not allow is left out.
// Then one model call, with no tool and no history, writes the brief from those reads, given as
// data, which the conversation keeps as the assistant's answer, with what its numbers and keys name.
// Should the model fail or write nothing, the harness lays out the same sections itself. The day's
// read the platform's broker refuses for want of the owner's permission for their assistant to act
// for them is the exception: the brief reads nothing else and gives way to the harness's question
// about it, once, and says nothing on the next mornings until the day's read works again. The
// owner's yes to that question, once they gave the platform their permission, sends that day's
// brief, however late.
export function makeBriefRunner(deps: BriefRunnerDeps): BriefRunner {
	const { config, db, llm, tools, admission, gate, clock, consentMetrics } = deps;

	// One read of the brief, through the same tool and checks as the model's calls, with nobody to
	// ask, but for the question about the owner's permission when the context asks it
	async function read<T>(
		context: ToolContext,
		name: string,
		args: Record<string, unknown>,
		schema: z.ZodType<T>
	): Promise<Read<T>> {
		const tool = tools.find(name);
		if (tool === null) return { ok: false, reason: 'unavailable' };
		let outcome: ToolOutcome;
		try {
			outcome = await runTool(tool, args, { ...context, unattended: true });
		} catch {
			return { ok: false, reason: 'failed' };
		}
		return readOf(outcome, schema);
	}

	// The day's read, which asks the owner nothing, but for the question about their permission
	// while no brief waits for their answer to it
	async function readDay(
		context: ToolContext,
		date: string,
		asksDelegation: boolean
	): Promise<Read<Day>> {
		return dayOf(
			await read(
				asksDelegation ? { ...context, asksDelegation } : context,
				LIST_EVENTS,
				{ from: date, days: 1, limit: MAX_MEETINGS },
				listSchema
			)
		);
	}

	async function readInvitations(context: ToolContext, date: string): Promise<Read<Invitations>> {
		const list = await read(
			context,
			LIST_EVENTS,
			{
				from: date,
				days: INVITATION_DAYS,
				limit: MAX_PENDING_OCCURRENCES,
				needs_action: true
			},
			listSchema
		);
		if (!list.ok) return list;
		return { ok: true, value: invitationsOf(list.value.events, list.value.truncated) };
	}

	// The owner's late tasks, then those of the day, the day being the one it is in the zone given:
	// left out together when either read is
	async function readTasks(context: ToolContext, zone: string): Promise<Read<Tasks>> {
		const overdue = await read(
			context,
			LIST_TASKS,
			{ zone, due: 'overdue', limit: MAX_TASKS },
			taskListSchema
		);
		if (!overdue.ok) return overdue;
		const today = await read(
			context,
			LIST_TASKS,
			{ zone, due: 'today', limit: MAX_TASKS },
			taskListSchema
		);
		if (!today.ok) return today;
		const late = overdue.value.tasks.slice(0, MAX_TASKS);
		return {
			ok: true,
			value: {
				overdue: late,
				today: today.value.tasks.slice(0, MAX_TASKS - late.length),
				truncated:
					overdue.value.truncated ||
					today.value.truncated ||
					overdue.value.tasks.length + today.value.tasks.length > MAX_TASKS
			}
		};
	}

	// The brief's reads after the day's, and the zone it is written in
	async function readSections(
		context: ToolContext,
		date: string,
		calendar: Read<Day>
	): Promise<{ readonly sections: Sections; readonly timeZone: string }> {
		const invitations = await readInvitations(context, date);
		// Read once the calendar's reads may have named it, as a turn reads it: the zone of the
		// owner's calendar, which the days of their tasks are counted in, and the brief written in
		const timeZone = await fetchOwnerTimeZone(db, context.principalId, config.timeZone);
		return {
			sections: { calendar, invitations, tasks: await readTasks(context, timeZone) },
			timeZone
		};
	}

	// The brief as the model writes it from its reads, in one call with no tool and no history, and
	// the tokens it took: no text when the model failed or wrote nothing
	async function written(
		system: string,
		told: string,
		log: FastifyBaseLogger
	): Promise<{ readonly text: string | null; readonly tokens: number }> {
		const prompt: LlmMessage[] = [
			{ role: 'system', content: system },
			{ role: 'user', content: told }
		];
		try {
			const completion = await llm.complete(prompt, []);
			const text = withoutCallMarkup(completion.content ?? '').trim();
			const tokens =
				(completion.usage?.promptTokens ?? 0) + (completion.usage?.completionTokens ?? 0);
			if (text.length > 0) return { text, tokens };
			log.warn({ tokens }, 'brief model wrote nothing');
			return { text: null, tokens };
		} catch (err: unknown) {
			if (!(err instanceof LlmError)) throw err;
			log.warn({ err }, 'brief model failed');
			return { text: null, tokens: 0 };
		}
	}

	// The brief gives way to the harness's question about the owner's permission, which the
	// conversation keeps as the assistant's answer, as it keeps a turn's, and waits for their answer
	// to it from then on, in the same transaction as what else ends with it
	async function giveWay(
		writing: Writing,
		question: DelegationQuestion,
		alongside?: (tx: Tx) => Promise<unknown>
	): Promise<BriefResult> {
		const { principal, session, date } = writing;
		const saved = await withPrincipal(db, principal, async (tx) => {
			const kept = await saveSessionMessages(tx, session.id, [
				...session.messages,
				{ role: 'user', content: writing.told },
				{ role: 'assistant', content: question.text }
			]);
			if (kept) {
				await alongside?.(tx);
				await keepBriefWait(tx, principal.id, { date, pendingCallId: question.pendingCallId });
			}
			return kept;
		});
		if (!saved) return { kind: 'missing' };
		writing.log.info({ pendingCallId: question.pendingCallId }, 'brief gave way to a question');
		return { kind: 'question', ...question };
	}

	// The brief of its date, written from its reads in the zone given, by the model unless admission
	// refused it for a spent day, which the conversation keeps as the assistant's answer, in the same
	// transaction as what else ends with it. A request that closed unanswered with it expired, as one
	// past its lifetime does, and counts the same.
	async function writeBrief(
		writing: Writing,
		sections: Sections,
		timeZone: string,
		ending: (tx: Tx) => Promise<ClosedRequest | null>
	): Promise<BriefResult> {
		const { principal, session, locale, date, log, refusedFor } = writing;
		const messages = getMessages(locale);
		for (const [name, skipped] of readsOf(sections)) logSkipped(name, skipped, log);
		const told = `${writing.told}\n${messages.brief.day(fenced(BRIEF_DATA, dataOf(date, sections)))}`;
		const moment = describeMoment(clock.now(), timeZone, locale);
		const system = buildSystemPrompt({
			persona: deps.persona(writing.assistantName, messages),
			moment: messages.now(moment.words, moment.iso, moment.timeZone),
			memory: { memory: [], user: [] },
			history: [],
			nudgeInterval: 0
		});
		const model =
			refusedFor === null ? await written(system, told, log) : { text: null, tokens: 0 };
		// The model's brief repeats titles people wrote, unasked, every morning: its Markdown renders
		// with nothing that acts, as the harness quotes the model in its requests, never their HTML or
		// links
		const brief: Laid =
			model.text === null
				? template(sections, date, locale, messages.brief.template)
				: { text: model.text, html: renderQuotedMarkdown(model.text) };
		// The conversation keeps the brief as the owner reads it, and what its numbers and keys name,
		// as data, in place of what any earlier brief's named: not the data it was written from,
		// which every later turn would carry
		const references = referencesOf(sections);
		const kept =
			references === null
				? writing.told
				: `${writing.told}\n${messages.brief.references(fenced(BRIEF_REFERENCES, references))}`;
		const saved = await withPrincipal(db, principal, async (tx) => {
			const stored = await saveSessionMessages(tx, session.id, [
				...session.messages.map(withoutReferences),
				{ role: 'user', content: kept },
				{ role: 'assistant', content: brief.text }
			]);
			return stored ? { closed: await ending(tx) } : null;
		});
		if (saved === null) return { kind: 'missing' };
		const { closed } = saved;
		if (closed !== null) {
			log.info({ owner: principal.id, pendingCallId: closed.pendingCallId }, 'request expired');
			consentMetrics.expired(closed);
		}
		if (model.tokens > 0) await admission.recordUsage(principal.id, model.tokens, 'brief');
		log.info(
			{
				by: model.text === null ? 'template' : 'model',
				meetings: sections.calendar.ok ? sections.calendar.value.meetings.length : null,
				invitations: sections.invitations.ok ? sections.invitations.value.pending.length : null,
				tasks: sections.tasks.ok
					? sections.tasks.value.overdue.length + sections.tasks.value.today.length
					: null,
				tokens: model.tokens,
				...(refusedFor === null ? {} : { refused: refusedFor })
			},
			'brief written'
		);
		return {
			kind: 'ok',
			text: brief.text,
			html: brief.html,
			date,
			...(refusedFor === null ? {} : { refusedFor })
		};
	}

	async function runAdmitted(
		input: BriefInput,
		refusedFor: SpentReason | null
	): Promise<BriefResult> {
		const { principal, roomId, date } = input;
		const opened = await withPrincipal(db, principal, async (tx) => {
			const record = await ensurePrincipal(tx, principal);
			if (!record.actions.includes('chat')) return null;
			const locale = localeOf(await findAssistant(tx, principal.id), config.locale);
			const session = await ensureRoomSession(tx, principal.id, roomId);
			const waiting = await findBriefWait(tx, principal.id);
			return { actions: record.actions, locale, session, waiting };
		});
		if (opened === null) return { kind: 'forbidden' };
		const { actions, locale, session, waiting } = opened;
		const log = input.log.child({ session: session.id, principal: principal.id });
		const writing: Writing = {
			principal,
			session,
			locale,
			told: input.told,
			date,
			assistantName: input.assistantName,
			log,
			refusedFor
		};
		const context: ToolContext = {
			principalId: principal.id,
			origin: 'event',
			actions,
			db,
			correlationId: input.correlationId,
			sessionId: session.id,
			log
		};
		// A brief that waits for the owner's answer to the question it gave way to asks it no more
		const calendar = await readDay(context, date, waiting === null);
		if (!calendar.ok && calendar.question !== undefined) {
			logSkipped('calendar', calendar, log);
			return giveWay(writing, calendar.question);
		}
		// It says nothing until the day's read works again, whatever keeps it from working
		if (!calendar.ok && waiting !== null) {
			logSkipped('calendar', calendar, log);
			log.info({ pendingCallId: waiting.pendingCallId, since: waiting.date }, 'brief withheld');
			return { kind: 'withheld' };
		}
		const { sections, timeZone } = await readSections(context, date, calendar);
		return writeBrief(writing, sections, timeZone, (tx) => endBriefWait(tx, principal.id));
	}

	// The owner's yes runs the read the brief gave way for, as it was frozen, under the brief's own
	// id, then the brief's other reads: that day's brief, written from them, goes out then, however
	// late, and no brief waits any more. While the broker still refuses the read, the brief waits for
	// their answer to the harness's new question, which supersedes the one they answered.
	async function resumeAdmitted(
		input: BriefResumeInput,
		refusedFor: SpentReason | null
	): Promise<BriefResult> {
		const { principal, roomId, pendingCallId } = input;
		const opened = await withPrincipal(db, principal, async (tx) => {
			const record = await ensurePrincipal(tx, principal);
			if (!record.actions.includes('chat')) return { kind: 'forbidden' as const };
			// Only the brief that waits for the call runs it: one that went out since closed its
			// question
			const waiting = await findBriefWait(tx, principal.id);
			if (waiting?.pendingCallId !== pendingCallId) return { kind: 'missing' as const };
			const approved = await approvePendingCall(tx, principal.id, pendingCallId);
			if (approved === null) return { kind: 'missing' as const };
			const locale = localeOf(await findAssistant(tx, principal.id), config.locale);
			const session = await ensureRoomSession(tx, principal.id, roomId);
			const { actions } = record;
			return { kind: 'ok' as const, actions, locale, session, approved, date: waiting.date };
		});
		if (opened.kind !== 'ok') return opened;
		const { actions, locale, session, approved, date } = opened;
		const log = input.log.child({ session: session.id, principal: principal.id });
		const id = briefId(principal.id, date);
		const writing: Writing = {
			principal,
			session,
			locale,
			told: getMessages(locale).brief.intro(id),
			date,
			assistantName: input.assistantName,
			log,
			refusedFor
		};
		const context: ToolContext = {
			principalId: principal.id,
			origin: 'event',
			actions,
			db,
			correlationId: id,
			sessionId: session.id,
			log
		};
		const calendar = dayOf(
			readOf(
				await deps.runFrozenCall(
					approved,
					pendingCallId,
					{ ...context, origin: approved.origin, unattended: true, asksDelegation: true },
					log
				),
				listSchema
			)
		);
		if (!calendar.ok && calendar.question !== undefined) {
			logSkipped('calendar', calendar, log);
			return giveWay(writing, calendar.question, (tx) =>
				supersedeApprovedCall(tx, principal.id, pendingCallId)
			);
		}
		const { sections, timeZone } = await readSections(context, date, calendar);
		return writeBrief(writing, sections, timeZone, async (tx) => {
			await markReplayed(tx, pendingCallId);
			return endBriefWait(tx, principal.id);
		});
	}

	// Admitted before anything else runs, as a turn is; the slot is held until the brief is written.
	// Refused for a spent day, it goes out all the same, laid out by the harness.
	async function admitted(
		owner: string,
		run: (refusedFor: SpentReason | null) => Promise<BriefResult>
	): Promise<BriefResult> {
		const decision = await admission.admit(owner, 'brief');
		if (!decision.ok) {
			const { reason } = decision.refusal;
			if (!spentForTheDay(reason)) return { kind: 'busy', ...decision.refusal };
			return gate.run(owner, () => run(reason));
		}
		try {
			return await gate.run(owner, () => run(null));
		} finally {
			decision.release();
		}
	}

	return {
		run: (input) => admitted(input.principal.id, (refusedFor) => runAdmitted(input, refusedFor)),
		resume: (input) =>
			admitted(input.principal.id, (refusedFor) => resumeAdmitted(input, refusedFor))
	};
}
