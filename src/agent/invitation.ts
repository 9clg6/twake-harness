import { randomBytes } from 'node:crypto';

import { fenced } from '../wakeups/wake.js';
import { findTimeZone, formatOffset, offsetMinutesAt } from './clock.js';
import type { ToolOutcome } from './tools.js';

// The CloudEvent type of an invitation, as the calendar producer names it and the dispatcher
// posts it: the events whose slot the harness checks before the model speaks
export const INVITED_EVENT_TYPE = 'com.twake.calendar.event.invited.v1';

export function isInvitationEvent(type: string): boolean {
	return type === INVITED_EVENT_TYPE;
}

// What the calendar producer writes of an invitation's time, in data.object: start and end from
// DTSTART and DTEND, and the TZID, "UTC", or null for an all-day event
export interface InvitationTimes {
	readonly start: unknown;
	readonly end: unknown;
	readonly timezone: unknown;
}

// What the wake-up of an invitation carries for the harness to check it: its UID, and its times
// as the calendar wrote them
export interface Invitation {
	readonly uid: string;
	readonly start: string | null;
	readonly end: string | null;
	readonly timezone: string | null;
}

// The period read_freebusy is asked about, or why it is not asked
export type InvitationSlot =
	| { readonly ok: true; readonly start: string; readonly end: string }
	| { readonly ok: false; readonly reason: string };

type TimeOf =
	{ readonly ok: true; readonly time: string } | { readonly ok: false; readonly reason: string };

// read_freebusy refuses a longer period, as the contract does
const LONGEST_PERIOD_MS = 31 * 24 * 60 * 60 * 1000;
const NOT_CHECKED = 'availability not checked: ';

// RFC 3339 with its offset or Z, the shape read_freebusy accepts as it is
const AWARE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
// A wall time without offset, written when the event's TZID is unknown to the producer's image
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
// The date of an all-day event
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(year: string, month: string, day: string): boolean {
	const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
	return (
		date.getUTCFullYear() === Number(year) &&
		date.getUTCMonth() === Number(month) - 1 &&
		date.getUTCDate() === Number(day)
	);
}

// A wall time of a zone as RFC 3339 with the zone's offset at that time: the offset at the instant
// first guessed, then again at the instant that offset gives, which settles a time near a change
// of offset, daylight saving time included
function inZone(
	date: readonly [string, string, string],
	time: readonly [string, string, string],
	timeZone: string
): string {
	const [year, month, day] = date;
	const [hour, minute, second] = time;
	const wall = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second)
	);
	const guessed = offsetMinutesAt(new Date(wall), timeZone);
	const settled = offsetMinutesAt(new Date(wall - guessed * 60_000), timeZone);
	return `${year}-${month}-${day}T${hour}:${minute}:${second}${formatOffset(settled)}`;
}

function timeOf(
	value: unknown,
	timezone: unknown,
	defaultZone: string,
	which: 'start' | 'end'
): TimeOf {
	if (value === null || value === undefined || value === '') {
		return { ok: false, reason: `${NOT_CHECKED}no ${which} time` };
	}
	const unreadable: TimeOf = { ok: false, reason: `${NOT_CHECKED}unreadable ${which} time` };
	if (typeof value !== 'string') return unreadable;
	if (AWARE.test(value))
		return Number.isNaN(Date.parse(value)) ? unreadable : { ok: true, time: value };
	const date = DATE.exec(value);
	if (date !== null) {
		const [, year = '', month = '', day = ''] = date;
		if (!isCalendarDate(year, month, day)) return unreadable;
		// An all-day event runs from midnight to midnight where the deployment is
		return { ok: true, time: inZone([year, month, day], ['00', '00', '00'], defaultZone) };
	}
	const wall = WALL.exec(value);
	if (wall === null) return unreadable;
	const [, year = '', month = '', day = '', hour = '', minute = '', second = '00'] = wall;
	if (!isCalendarDate(year, month, day)) return unreadable;
	if (typeof timezone !== 'string' || timezone.length === 0) {
		return { ok: false, reason: `${NOT_CHECKED}a time without offset and no time zone` };
	}
	const zone = findTimeZone(timezone);
	if (zone === null) return { ok: false, reason: `${NOT_CHECKED}unknown time zone ${timezone}` };
	return { ok: true, time: inZone([year, month, day], [hour, minute, second], zone) };
}

// The invitation's own period, as read_freebusy takes it, or why it is not asked: the contract
// refuses a time without offset, a period that ends before it starts and one over 31 days, so
// none of those is ever sent, and no length is guessed for an event without an end
export function invitationSlot(times: InvitationTimes, defaultZone: string): InvitationSlot {
	const start = timeOf(times.start, times.timezone, defaultZone, 'start');
	if (!start.ok) return start;
	const end = timeOf(times.end, times.timezone, defaultZone, 'end');
	if (!end.ok) return end;
	const from = Date.parse(start.time);
	const to = Date.parse(end.time);
	if (to <= from) {
		return { ok: false, reason: `${NOT_CHECKED}the invitation ends before it starts` };
	}
	if (to - from > LONGEST_PERIOD_MS) {
		return { ok: false, reason: `${NOT_CHECKED}the invitation lasts over 31 days` };
	}
	return { ok: true, start: start.time, end: end.time };
}

// Runs a tool of the turn by its name, through the same path as the model's own calls and with
// the same context, or tells that the catalog has no such tool
export type ToolRunner = (
	name: string,
	args: Readonly<Record<string, unknown>>
) => Promise<ToolOutcome | null>;

export interface InvitationCheck {
	// What the calendar answered, fenced as data, for the message the model reads
	readonly data: string;
	// For the logs, never the content: how each read ended, and why the slot went unchecked
	readonly eventStatus: number | null;
	readonly freeBusyStatus: number | null;
	readonly reason: string | null;
}

export interface InvitationCheckOptions {
	// The deployment's zone, for an all-day event
	readonly timeZone: string;
	// The random part of the fence, so that the data cannot close the block it sits in; set by
	// tests only
	readonly nonce?: string;
}

const READ_EVENT = 'read_event';
const READ_FREEBUSY = 'read_freebusy';

function statusOf(outcome: ToolOutcome): number | null {
	const result = outcome.result;
	if (typeof result !== 'object' || result === null || !('status' in result)) return null;
	return typeof result.status === 'number' ? result.status : null;
}

function isSuccess(status: number | null): status is number {
	return status !== null && status >= 200 && status < 300;
}

function field(value: unknown, key: string): unknown {
	return typeof value === 'object' && value !== null && key in value
		? (value as Record<string, unknown>)[key]
		: undefined;
}

// One read, as the model will see it: the call and what came back, on one line of JSON, so that
// nothing a third party wrote can start a line of its own
function described(
	name: string,
	args: Readonly<Record<string, unknown>>,
	outcome: ToolOutcome
): string {
	return `${name} ${JSON.stringify(args)} -> ${JSON.stringify(outcome.result)}`;
}

// Before the model speaks about an invitation, the harness reads it and checks its slot itself,
// through the same contracts and in the same context as the model would: whether the owner is
// free is the heart of the proposal, so it does not depend on the model choosing to call a tool.
// What came back is handed to the model as data, an error too; a read that waits for its owner,
// such as one the platform's broker refused, leaves the owner to the harness's own question.
export async function checkInvitation(
	run: ToolRunner,
	eventId: string,
	options: InvitationCheckOptions
): Promise<InvitationCheck> {
	const nonce = options.nonce ?? randomBytes(6).toString('hex');
	const lines: string[] = [];
	// A read that throws becomes data too: the turn goes on and the model says it could not check
	const call = async (
		name: string,
		args: Readonly<Record<string, unknown>>
	): Promise<ToolOutcome | null> => {
		try {
			return await run(name, args);
		} catch (err: unknown) {
			return {
				result: { error: `the call failed: ${err instanceof Error ? err.message : String(err)}` }
			};
		}
	};
	const finish = (
		eventStatus: number | null,
		freeBusyStatus: number | null,
		reason: string | null
	): InvitationCheck => ({
		data: [`<<<calendar-data ${nonce}`, ...lines, `calendar-data ${nonce}>>>`].join('\n'),
		eventStatus,
		freeBusyStatus,
		reason
	});

	const eventArgs = { event_id: eventId };
	const event = await call(READ_EVENT, eventArgs);
	if (event === null) {
		const reason = 'the calendar contract read_event is not available';
		lines.push(`read_event: not called, ${reason}`, 'read_freebusy: not called');
		return finish(null, null, reason);
	}
	lines.push(described(READ_EVENT, eventArgs, event));
	const eventStatus = statusOf(event);
	if (!isSuccess(eventStatus)) {
		const reason = 'the invitation could not be read';
		lines.push(`read_freebusy: not called, ${reason}`);
		return finish(eventStatus, null, reason);
	}

	const object = field(field(field(event.result, 'body'), 'data'), 'object');
	const uid = field(object, 'uid');
	if (typeof uid !== 'string' || uid.length === 0) {
		const reason = 'availability not checked: the invitation has no uid';
		lines.push(`read_freebusy: not called, ${reason}`);
		return finish(eventStatus, null, reason);
	}
	const slot = invitationSlot(
		{
			start: field(object, 'start'),
			end: field(object, 'end'),
			timezone: field(object, 'timezone')
		},
		options.timeZone
	);
	if (!slot.ok) {
		lines.push(`read_freebusy: not called, ${slot.reason}`);
		return finish(eventStatus, null, slot.reason);
	}
	// The invitation is already in the owner's calendar: left out, it does not count against itself
	const freeBusyArgs = { start: slot.start, end: slot.end, exclude: [uid] };
	const freeBusy = await call(READ_FREEBUSY, freeBusyArgs);
	if (freeBusy === null) {
		const reason = 'availability not checked: the calendar contract read_freebusy is not available';
		lines.push(`read_freebusy: not called, ${reason}`);
		return finish(eventStatus, null, reason);
	}
	lines.push(described(READ_FREEBUSY, freeBusyArgs, freeBusy));
	const freeBusyStatus = statusOf(freeBusy);
	return finish(
		eventStatus,
		freeBusyStatus,
		isSuccess(freeBusyStatus) ? null : 'availability not checked: the free/busy read failed'
	);
}

// What the calendar answered of an invitation's slot, as the model reads it
const CALENDAR_DATA = 'calendar-data';

export interface AvailabilityCheck {
	// What the calendar answered, fenced as data, for the message the model reads
	readonly data: string;
	// For the logs, never the content: how the read ended, and why the slot went unchecked
	readonly freeBusyStatus: number | null;
	readonly reason: string | null;
}

// Before the model speaks about an invitation, the harness checks its owner's availability over its
// slot itself, from the times its wake-up carries, through the same contract and in the same
// context as the model would: whether the owner is free is the heart of the proposal, so it does
// not depend on the model choosing to call a tool. What came back is handed to the model as data,
// an error too; a read that waits for its owner, such as one the platform's broker refused, leaves
// the owner to the harness's own question.
export async function checkAvailability(
	run: ToolRunner,
	invitation: Invitation,
	options: { readonly timeZone: string }
): Promise<AvailabilityCheck> {
	const unchecked = (reason: string): AvailabilityCheck => ({
		data: fenced(CALENDAR_DATA, { tool: READ_FREEBUSY, not_called: reason }),
		freeBusyStatus: null,
		reason
	});
	const slot = invitationSlot(invitation, options.timeZone);
	if (!slot.ok) return unchecked(slot.reason);
	// The invitation is already in the owner's calendar: left out, it does not count against itself
	const args = { start: slot.start, end: slot.end, exclude: [invitation.uid] };
	let outcome: ToolOutcome | null;
	try {
		outcome = await run(READ_FREEBUSY, args);
	} catch (err: unknown) {
		// A read that throws becomes data too: the turn goes on and the model says it could not check
		const message = err instanceof Error ? err.message : String(err);
		outcome = { result: { error: `the call failed: ${message}` } };
	}
	if (outcome === null) {
		return unchecked(
			'availability not checked: the calendar contract read_freebusy is not available'
		);
	}
	const freeBusyStatus = statusOf(outcome);
	return {
		data: fenced(CALENDAR_DATA, { tool: READ_FREEBUSY, arguments: args, result: outcome.result }),
		freeBusyStatus,
		reason: isSuccess(freeBusyStatus) ? null : 'availability not checked: the free/busy read failed'
	};
}
