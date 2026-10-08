import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

import { localeOf } from '../assistants/locale.js';
import { findAssistant } from '../assistants/repository.js';
import type { Config } from '../config.js';
import { withPrincipal, type Db } from '../db/client.js';
import { getMessages, type Messages } from '../i18n/messages.js';
import { LlmError, type LlmClient, type LlmMessage } from '../llm/client.js';
import { fenced } from '../llm/data.js';
import type { Principal } from '../principals/principal.js';
import { ensurePrincipal } from '../principals/repository.js';
import { ensureRoomSession, saveSessionMessages } from '../sessions/repository.js';
import { fetchOwnerTimeZone } from '../settings/time-zone.js';
import type { Admission, Refusal } from './admission.js';
import { withoutCallMarkup } from './call-markup.js';
import { describeMoment, type Clock } from './clock.js';
import type { TurnGate } from './gate.js';
import { buildSystemPrompt } from './prompt.js';
import { runTool, type ToolContext, type ToolRegistry } from './tools.js';

// The calendar's operation the brief reads the day of, and the most meetings it reads of one
const LIST_EVENTS = 'list_calendar_events';
const MAX_MEETINGS = 20;

// What the day's read hands the model, as the invitation check's reads do
const CALENDAR_DATA = 'calendar-data';

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

const daySchema = z.object({
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

// The day's read of the owner's calendar, or why there is none: an application that needs a yes
// the owner did not give, here or on the platform, is not read, and nobody asks them for it
type DayRead =
	| { readonly ok: true; readonly day: Day }
	| { readonly ok: false; readonly reason: string; readonly status?: number };

export interface BriefInput {
	readonly principal: Principal;
	readonly roomId: string;
	// What the owner's assistant is told their day starts with, as its wake-up wrote it
	readonly told: string;
	// The date, in the owner's zone, the brief is of
	readonly date: string;
	readonly log: FastifyBaseLogger;
	// What links the day's read in the audit: the brief's own id
	readonly correlationId: string;
	// The name the owner gave the assistant, when there is one
	readonly assistantName?: string;
}

export type BriefResult =
	// The brief, as the model wrote it, or as the harness lays it out when the model wrote nothing
	| { readonly kind: 'ok'; readonly text: string; readonly html?: string }
	| { readonly kind: 'forbidden' }
	| { readonly kind: 'missing' }
	// Admission refused it, as it would a turn
	| ({ readonly kind: 'busy' } & Refusal);

export interface BriefRunnerDeps {
	readonly config: Config;
	readonly db: Db;
	readonly llm: LlmClient;
	readonly tools: ToolRegistry;
	readonly admission: Admission;
	readonly gate: TurnGate;
	readonly clock: Clock;
	// The assistant's persona, as its owner's turns give it, in its owner's language
	persona(assistantName: string | undefined, messages: Messages): string;
}

export interface BriefRunner {
	run(input: BriefInput): Promise<BriefResult>;
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The wall time of a time the calendar gave in its day's zone, with that zone's offset: 09:00
function wallTimeOf(time: string): string {
	return /T(\d{2}:\d{2})/.exec(time)?.[1] ?? time;
}

// The day's meetings as the harness lays them out itself, for the owner, when the model wrote
// nothing: each one with its times and title, and the titles of those it overlaps that the day
// lists. People's titles are text, never markup.
function template(
	read: DayRead,
	dateWords: string,
	words: Messages['brief']['template']
): { readonly text: string; readonly html: string } {
	if (!read.ok) return { text: words.notRead, html: `<p>${escapeHtml(words.notRead)}</p>` };
	const { meetings, truncated } = read.day;
	if (meetings.length === 0) {
		const none = words.none(dateWords);
		return { text: none, html: `<p>${escapeHtml(none)}</p>` };
	}
	const titleOf = (meeting: Meeting): string => meeting.untrusted.title ?? words.untitled;
	const lines = meetings.map((meeting) => {
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
			: `${wallTimeOf(meeting.start)}–${wallTimeOf(meeting.end)} ${title}${overlaps}`;
	});
	const heading = words.heading(dateWords);
	const more = truncated ? [words.truncated] : [];
	return {
		text: [heading, ...lines.map((line) => `- ${line}`), ...more].join('\n'),
		html: [
			`<p>${escapeHtml(heading)}</p>`,
			`<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
			...more.map((line) => `<p>${escapeHtml(line)}</p>`)
		].join('\n')
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

// The brief of an owner's working day, which the worker role's scheduler asks their assistant for.
// Admitted as a turn is, it reads the day's meetings of their calendar itself, through the same
// tool and checks as the model's calls, with nobody to ask: an application they did not allow is
// left out. Then one model call, with no tool and no history, writes the brief from that day, given
// as data, which the conversation keeps as the assistant's answer. Should the model fail or write
// nothing, the harness lays out the same meetings itself.
export function makeBriefRunner(deps: BriefRunnerDeps): BriefRunner {
	const { config, db, llm, tools, admission, gate, clock } = deps;

	async function readDay(context: ToolContext, date: string): Promise<DayRead> {
		const tool = tools.find(LIST_EVENTS);
		if (tool === null) return { ok: false, reason: 'unavailable' };
		let result: unknown;
		try {
			({ result } = await runTool(
				tool,
				{ from: date, days: 1, limit: MAX_MEETINGS },
				{ ...context, unattended: true }
			));
		} catch {
			return { ok: false, reason: 'failed' };
		}
		const reason = notAskedReason(result);
		if (reason !== null) return { ok: false, reason };
		const answer = answerOf(result);
		if (answer === null || answer.status < 200 || answer.status >= 300) {
			return { ok: false, reason: 'failed', ...(answer === null ? {} : { status: answer.status }) };
		}
		const parsed = daySchema.safeParse(answer.body);
		if (!parsed.success) return { ok: false, reason: 'unreadable', status: answer.status };
		const { time_zone, events, truncated } = parsed.data;
		return {
			ok: true,
			day: {
				time_zone,
				meetings: events.slice(0, MAX_MEETINGS),
				truncated: truncated || events.length > MAX_MEETINGS
			}
		};
	}

	// The brief as the model writes it from the day, in one call with no tool and no history, and
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

	async function runAdmitted(input: BriefInput): Promise<BriefResult> {
		const { principal, roomId, date } = input;
		const opened = await withPrincipal(db, principal, async (tx) => {
			const record = await ensurePrincipal(tx, principal);
			if (!record.actions.includes('chat')) return null;
			const locale = localeOf(await findAssistant(tx, principal.id), config.locale);
			const session = await ensureRoomSession(tx, principal.id, roomId);
			return { actions: record.actions, locale, session };
		});
		if (opened === null) return { kind: 'forbidden' };
		const { actions, locale, session } = opened;
		const messages = getMessages(locale);
		const log = input.log.child({ session: session.id, principal: principal.id });
		const read = await readDay(
			{
				principalId: principal.id,
				origin: 'event',
				actions,
				db,
				correlationId: input.correlationId,
				sessionId: session.id,
				log
			},
			date
		);
		if (!read.ok) {
			log.info(
				{
					domain: 'calendar',
					reason: read.reason,
					...(read.status === undefined ? {} : { status: read.status })
				},
				'brief application skipped'
			);
		}
		const told = `${input.told}\n${messages.brief.day(
			fenced(
				CALENDAR_DATA,
				read.ok ? { date, calendar: read.day } : { date, not_read: { calendar: read.reason } }
			)
		)}`;
		// Read when the brief is written, as a turn reads it: the zone of the owner's calendar
		const timeZone = await fetchOwnerTimeZone(db, principal.id, config.timeZone);
		const moment = describeMoment(clock.now(), timeZone, locale);
		const system = buildSystemPrompt({
			persona: deps.persona(input.assistantName, messages),
			moment: messages.now(moment.words, moment.iso, moment.timeZone),
			memory: { memory: [], user: [] },
			history: [],
			nudgeInterval: 0
		});
		const model = await written(system, told, log);
		// Its date in words, as the owner reads it: the brief's own, whatever day it goes out on
		const brief: { readonly text: string; readonly html?: string } =
			model.text === null
				? template(
						read,
						describeMoment(new Date(`${date}T12:00:00Z`), 'UTC', locale).date,
						messages.brief.template
					)
				: { text: model.text };
		const saved = await withPrincipal(db, principal, (tx) =>
			saveSessionMessages(tx, session.id, [
				...session.messages,
				{ role: 'user', content: told },
				{ role: 'assistant', content: brief.text }
			])
		);
		if (!saved) return { kind: 'missing' };
		if (model.tokens > 0) await admission.recordUsage(principal.id, model.tokens);
		log.info(
			{
				by: model.text === null ? 'template' : 'model',
				meetings: read.ok ? read.day.meetings.length : null,
				tokens: model.tokens
			},
			'brief written'
		);
		return {
			kind: 'ok',
			text: brief.text,
			...(brief.html === undefined ? {} : { html: brief.html })
		};
	}

	return {
		async run(input) {
			const { principal } = input;
			// Admitted before anything else runs, as a turn is; the slot is held until the brief is
			// written
			const decision = await admission.admit(principal.id);
			if (!decision.ok) return { kind: 'busy', ...decision.refusal };
			try {
				return await gate.run(principal.id, () => runAdmitted(input));
			} finally {
				decision.release();
			}
		}
	};
}
