import { findTimeZone, type TimeZone } from './clock.js';

// What the harness does with a call to one of the calendar's operations, beyond making it
export interface CalendarOperation {
	// Whether its answer names, in time_zone, the zone of the owner's calendar, which the contract
	// reads from their calendar's settings and gives every time in: the zone a successful one names
	// is kept, and their turns state the present in it
	readonly namesOwnerZone: boolean;
	// The arguments its info line gives, of those the call carries, as it sent them, each by the
	// shape the contract takes it in. The model writes them, and the harness checks only their
	// names: one of another shape could hold any text, so the line names it without its value.
	readonly loggedArguments: Readonly<Record<string, RegExp>>;
}

// A day, written YYYY-MM-DD
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// A number of days, an integer from 1 to 31
const DAY_COUNT = /^(?:[1-9]|[12]\d|3[01])$/;

// The calendar's operations, by operationId, that the harness does more with than call them
const CALENDAR_OPERATIONS = new Map<string, CalendarOperation>([
	// The owner's events over whole days of their calendar's zone, from a date. The gateway's audit
	// keeps only the path of a call, and checking which days a list read, the ones the model took
	// for "today" or "tomorrow", takes its from and days.
	[
		'list_calendar_events',
		{ namesOwnerZone: true, loggedArguments: { from: DAY, days: DAY_COUNT } }
	],
	// One of the owner's events, or one occurrence of it
	['read_calendar_event', { namesOwnerZone: true, loggedArguments: {} }]
]);

// What the harness does with the calls of a contract, by its tool's name, when it is one of the
// calendar's operations above; null for any other
export function findCalendarOperation(toolName: string): CalendarOperation | null {
	return CALENDAR_OPERATIONS.get(toolName) ?? null;
}

// The zone an answer names in time_zone, by its canonical name: null when it names none the runtime
// knows
export function zoneOfAnswer(body: unknown): TimeZone | null {
	if (typeof body !== 'object' || body === null) return null;
	const zone = (body as Record<string, unknown>)['time_zone'];
	return typeof zone === 'string' ? findTimeZone(zone) : null;
}
