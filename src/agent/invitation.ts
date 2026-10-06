import { findTimeZone, formatOffset, offsetMinutesAt } from './clock.js';

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
