import { fenced } from '../llm/data.js';
import { findTimeZone, formatOffset, offsetMinutesAt } from './clock.js';
import type { ToolOutcome } from './tools.js';

// What an invitation's wake-up carries of its time: start and end from DTSTART and DTEND, and the
// TZID, "UTC", or null for an all-day event
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
// A wall time without offset, written when the event's TZID is unknown to the harness
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

// A wall time, such as 2026-10-13T18:00:00, in a zone the runtime knows, such as Europe/Paris, as
// RFC 3339 with the zone's offset then; null for a time or a zone it cannot read
export function wallTimeIn(wall: string, timeZone: string): string | null {
	const zone = findTimeZone(timeZone);
	const match = WALL.exec(wall);
	if (zone === null || match === null) return null;
	const [, year = '', month = '', day = '', hour = '', minute = '', second = '00'] = match;
	if (!isCalendarDate(year, month, day)) return null;
	return inZone([year, month, day], [hour, minute, second], zone);
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

const READ_FREEBUSY = 'read_freebusy';

function statusOf(outcome: ToolOutcome): number | null {
	const result = outcome.result;
	if (typeof result !== 'object' || result === null || !('status' in result)) return null;
	return typeof result.status === 'number' ? result.status : null;
}

function isSuccess(status: number | null): status is number {
	return status !== null && status >= 200 && status < 300;
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
