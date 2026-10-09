import { createHash } from 'node:crypto';
import { DeadLetterError, type RabbitMQMessage } from '@linagora/rabbitmq-client';
import ICAL from 'ical.js';
import { z } from 'zod';

import { formatOffset, wallTimeIn } from '../agent/clock.js';
import type { CalendarSource } from '../config.js';
import { cut } from '../llm/data.js';
import { matrixLocalpartOfPrincipal } from '../principals/identity.js';
import { CALENDAR_SOURCE } from '../sources/sources.js';
import {
	CANCELLED_EVENT_TYPE,
	INVITED_EVENT_TYPE,
	MOVED_EVENT_TYPE,
	RENAMED_EVENT_TYPE,
	type MeetingScope
} from './event-types.js';
import { listenOnOwnQueue, type Identity, type Listener, type Reading } from './listener.js';
import type { WakeDeps, Wakeup } from './wake.js';

// Where Calendar's side service sends a notification for each invitee of each change to a
// meeting, on Calendar's own vhost: a fanout, which gives every queue bound to it every message.
// The invitations of personal calendars never reach the activity exchange.
const CALENDAR_FANOUT = 'calendar:event:notificationEmail:send';

// The most characters of the title, the UID and the zone the model is shown: the organizer writes
// them, at any length, and one longer is cut rather than refused
const TITLE_MAX = 1000;
const UID_MAX = 255;
const ZONE_MAX = 64;

const EMAIL = z.email();

// An address as the calendar compares them: trimmed and in lower case, or null for anything else
function addressOf(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const address = value.trim().toLowerCase();
	return address.length === 0 ? null : address;
}

// The address of an ORGANIZER or an ATTENDEE, without mailto:, as the calendar compares them
function mailtoAddressOf(value: unknown): string | null {
	return typeof value === 'string' ? addressOf(value.trim().replace(/^mailto:/i, '')) : null;
}

// The organizer of an invitation: its ORGANIZER without mailto:, or the sender of the notification
// when it names none; whichever is an email address, so that nothing else passes for what the
// calendar computed
function organizerOf(vevent: ICAL.Component, sender: unknown, leftOut: string[]): string | null {
	const organizer = mailtoAddressOf(vevent.getFirstPropertyValue('organizer'));
	const candidates: [string, string | null][] = [
		['ORGANIZER', organizer],
		['senderEmail', addressOf(sender)]
	];
	for (const [field, candidate] of candidates) {
		if (candidate === null) continue;
		if (EMAIL.safeParse(candidate).success) return candidate;
		leftOut.push(field);
	}
	return null;
}

// The properties of free text the harness never reads: taken out before the iCalendar is parsed,
// with the lines they go on on, so that one written wrong can neither be read nor set the
// invitation aside
const NEVER_READ = /^(DESCRIPTION|LOCATION|COMMENT|ATTACH|X-ALT-DESC)[;:]/i;
// A line that starts a property, BEGIN and END included
const PROPERTY = /^[A-Za-z0-9-]+[;:]/;

function withoutFreeText(text: string): string {
	const kept: string[] = [];
	let leaving = false;
	for (const line of text.split(/\r?\n/)) {
		if (NEVER_READ.test(line)) {
			leaving = true;
			continue;
		}
		// A line folded onto the one before, or one that lost its fold, goes with its property
		if (leaving && line.length > 0 && (/^[ \t]/.test(line) || !PROPERTY.test(line))) continue;
		leaving = false;
		kept.push(line);
	}
	return kept.join('\r\n');
}

// The lines of an iCalendar, unfolded as the calendar producer read them: a line that goes on on
// the next one, after a space or a tab, is made whole
function unfolded(text: string): string[] {
	return text
		.replace(/\r\n/g, '\n')
		.replace(/\n[ \t]/g, '')
		.split('\n');
}

// The VEVENTs of an iCalendar as written, each as its unfolded lines, in their order
function writtenVevents(text: string): string[][] {
	const vevents: string[][] = [];
	let lines: string[] | null = null;
	for (const line of unfolded(text)) {
		if (/^BEGIN:VEVENT$/i.test(line)) {
			lines = [];
		} else if (/^END:VEVENT$/i.test(line)) {
			if (lines !== null) vevents.push(lines);
			lines = null;
		} else {
			lines?.push(line);
		}
	}
	return vevents;
}

// A content line as the calendar producer read it: a name, parameters, then the value after them
const CONTENT_LINE = /^[^;:]+((?:;[^:;"=]+=(?:"[^"]*"|[^:;"])*)*):(.*)$/;

// The value of a VEVENT's first property of a name, exactly as written, escapes included; null
// when it has none, or one the producer could not read either
function writtenValue(lines: readonly string[], name: 'UID' | 'RECURRENCE-ID'): string | null {
	const line = lines.find((candidate) => new RegExp(`^${name}[;:]`, 'i').test(candidate));
	return line === undefined ? null : (CONTENT_LINE.exec(line)?.[2] ?? null);
}

// One of an invitation's times, as RFC 3339 with the offset of the zone it names, and that zone;
// a date for an all-day event; a time in UTC with its Z; and the wall time as written for a time
// that names no zone, or one that neither the calendar nor the runtime knows
interface When {
	readonly at: string | null;
	readonly timezone: string | null;
}

const NO_TIME: When = { at: null, timezone: null };

// A time of an invitation in the zone it names
function timeAt(time: ICAL.Time, tzid: unknown): When {
	if (time.isDate) return { at: time.toString(), timezone: null };
	if (time.zone === ICAL.Timezone.utcTimezone) return { at: time.toString(), timezone: 'UTC' };
	if (typeof tzid !== 'string' || tzid.length === 0) return { at: time.toString(), timezone: null };
	// A zone the calendar does not define is read as the runtime knows it, an IANA name such as
	// Europe/Paris; any other leaves the time floating, its wall time as written
	if (time.zone === ICAL.Timezone.localTimezone) {
		return { at: wallTimeIn(time.toString(), tzid) ?? time.toString(), timezone: tzid };
	}
	// The zone as the calendar defines it, as sabre writes every zone an invitation names
	return { at: `${time.toString()}${formatOffset(time.utcOffset() / 60)}`, timezone: tzid };
}

function whenOf(
	vevent: ICAL.Component,
	name: 'dtstart' | 'dtend' | 'recurrence-id',
	leftOut: string[]
): When {
	const property = vevent.getFirstProperty(name);
	if (property === null) return NO_TIME;
	try {
		const time = property.getFirstValue();
		if (time instanceof ICAL.Time) return timeAt(time, property.getParameter('tzid'));
	} catch {
		// A time the calendar wrote wrong is no time: the rest of the invitation still counts
	}
	leftOut.push(name.toUpperCase());
	return NO_TIME;
}

// The end of an invitation: its DTEND, or else its start and its DURATION, in the start's zone
function endOf(vevent: ICAL.Component, leftOut: string[]): When {
	if (vevent.hasProperty('dtend')) return whenOf(vevent, 'dtend', leftOut);
	const start = vevent.getFirstProperty('dtstart');
	if (start === null || !vevent.hasProperty('duration')) return NO_TIME;
	try {
		const time = start.getFirstValue();
		const duration = vevent.getFirstPropertyValue('duration');
		if (time instanceof ICAL.Time && duration instanceof ICAL.Duration) {
			const end = time.clone();
			end.addDuration(duration);
			return timeAt(end, start.getParameter('tzid'));
		}
	} catch {
		// The start is left out on its own: here the duration alone
	}
	leftOut.push('DURATION');
	return NO_TIME;
}

// The VEVENT an invitation is about, as the parser reads it and as written: the first that is no
// occurrence of a series, which a series' own carries, else the first, which an invitation to one
// occurrence holds alone
interface Vevent {
	readonly parsed: ICAL.Component;
	readonly written: readonly string[];
}

function veventOf(event: unknown): Vevent {
	if (typeof event !== 'string') throw new DeadLetterError('a notification without its iCalendar');
	const text = withoutFreeText(event);
	let vevents: ICAL.Component[];
	try {
		const parsed: unknown = ICAL.parse(text);
		const roots = Array.isArray(parsed) && typeof parsed[0] === 'string' ? [parsed] : parsed;
		vevents = (Array.isArray(roots) ? roots : [])
			.map((root: unknown) => new ICAL.Component(root as unknown[]))
			.flatMap((root) => (root.name === 'vevent' ? [root] : root.getAllSubcomponents('vevent')));
	} catch (err: unknown) {
		throw new DeadLetterError('an iCalendar that cannot be read', { cause: err });
	}
	const written = writtenVevents(text);
	if (written.length !== vevents.length) {
		throw new DeadLetterError('an iCalendar whose VEVENTs do not read as they are written');
	}
	const own = written.findIndex((lines) => !lines.some((line) => /^RECURRENCE-ID[;:]/i.test(line)));
	const at = own === -1 ? 0 : own;
	const parsed = vevents[at];
	const lines = written[at];
	if (parsed === undefined || lines === undefined) {
		throw new DeadLetterError('an iCalendar without VEVENT');
	}
	return { parsed, written: lines };
}

// The id the calendar producer gave an invitation, which the gateway's audit records carry and an
// E2E computes again: the hex SHA-256 of its UID exactly as written, its invitee, its SEQUENCE, 0
// when it has none, and for an occurrence its RECURRENCE-ID exactly as written, joined with |, then
// what a wake-up that is no new invitation adds after them, so that it is told apart from the
// invitation at the same SEQUENCE: a cancellation, its method
function invitationId(
	vevent: Vevent,
	uid: string,
	recipient: string,
	added: readonly string[]
): string {
	const sequence = vevent.parsed.getFirstPropertyValue('sequence');
	const occurrence = writtenValue(vevent.written, 'RECURRENCE-ID');
	const parts = [
		uid,
		recipient,
		String(typeof sequence === 'number' ? sequence : 0),
		...(occurrence === null ? [] : [occurrence]),
		...added
	];
	return createHash('sha256').update(parts.join('|')).digest('hex');
}

// A time as Calendar's side service writes it in the changes of a notification: its wall time, to
// the microsecond, in the zone it names, or midnight of an all-day event's day
const CHANGED_TIME = z.object({ isAllDay: z.boolean(), date: z.string(), timezone: z.string() });
const CHANGED_WALL = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)?$/;
// A change of one of a meeting's times, of which the harness reads the time it had alone
const TIME_CHANGE = z.object({ previous: CHANGED_TIME });

// The time a change moved a meeting from, as its own times are shown: RFC 3339 with the offset of
// its zone, Z in UTC, or the date of an all-day event; null for one it cannot read
function formerTimeOf(change: unknown): string | null {
	const time = TIME_CHANGE.safeParse(change);
	if (!time.success) return null;
	const { isAllDay, date, timezone } = time.data.previous;
	const wall = CHANGED_WALL.exec(date);
	if (wall === null) return null;
	const [, day = '', clock = ''] = wall;
	if (isAllDay) return day;
	if (timezone === 'Z' || timezone === 'UTC') return `${day}T${clock}Z`;
	return wallTimeIn(`${day}T${clock}`, timezone);
}

// One of a meeting's times as a change left it: where it was, or moved from the time it had, as far
// as the harness reads what Calendar computed, null for one it cannot read
type Before = { readonly moved: false } | { readonly moved: true; readonly at: string | null };

// What a change to a meeting its invitee already had is to them: a move of its start or its end,
// which wakes them, a new title alone, which their journal keeps for their brief, or its
// cancellation, which wakes them too
type Change =
	| { readonly kind: 'moved'; readonly start: Before; readonly end: Before }
	| { readonly kind: 'renamed' }
	| { readonly kind: 'cancelled' };

// What a change to a meeting is, from the changes Calendar computed, or null when it neither moved
// it nor renamed it. The place and the description go first, before anything else of the changes
// is read; of the title, only that it changed is.
function changeOf(changes: unknown, leftOut: string[]): Change | null {
	if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) return null;
	const {
		location: _location,
		description: _description,
		...kept
	} = changes as Record<string, unknown>;
	if ('dtstart' in kept || 'dtend' in kept) {
		const before = (key: 'dtstart' | 'dtend'): Before => {
			if (!(key in kept)) return { moved: false };
			const at = formerTimeOf(kept[key]);
			if (at === null) leftOut.push(`changes.${key}`);
			return { moved: true, at };
		};
		return { kind: 'moved', start: before('dtstart'), end: before('dtend') };
	}
	return 'summary' in kept ? { kind: 'renamed' } : null;
}

// The type a meeting's wake-up takes: a new invitation, a move, a new title or a cancellation
const TYPE_OF_CHANGE: Readonly<Record<Change['kind'], string>> = {
	moved: MOVED_EVENT_TYPE,
	renamed: RENAMED_EVENT_TYPE,
	cancelled: CANCELLED_EVENT_TYPE
};

function typeOf(change: Change | null): string {
	return change === null ? INVITED_EVENT_TYPE : TYPE_OF_CHANGE[change.kind];
}

// Whether the invitee declined the meeting, as its VEVENT writes their participation once changed:
// the notification of an update carries the event as it was before with a counter-proposal alone
function declinedBy(vevent: ICAL.Component, recipient: string): boolean {
	return vevent.getAllProperties('attendee').some((attendee) => {
		const partstat: unknown = attendee.getParameter('partstat');
		return (
			mailtoAddressOf(attendee.getFirstValue()) === recipient &&
			typeof partstat === 'string' &&
			partstat.toUpperCase() === 'DECLINED'
		);
	});
}

// What a change to a meeting is about: one occurrence of a series when its VEVENT names one, the
// whole series when it repeats, else the meeting on its own
function scopeOf(vevent: Vevent): MeetingScope {
	if (writtenValue(vevent.written, 'RECURRENCE-ID') !== null) return 'occurrence';
	const repeats = vevent.parsed.hasProperty('rrule') || vevent.parsed.hasProperty('rdate');
	return repeats ? 'series' : 'event';
}

// The wake-up a new invitation brings its invitee, or a change to a meeting they were invited to:
// a move, which also shows where the meeting was and says what it is about, a new title, which
// waits for their brief, or a cancellation, which says what it is about and is told apart from the
// invitation at its SEQUENCE. What the calendar computed (the times, the organizer's address and the
// occurrence) is shown apart from what the organizer wrote (the title, the UID and the zone, under
// untrusted); the description and the location are never read. The check takes the UID and the
// zone whole. A VEVENT without UID throws a DeadLetterError that says why; a field the calendar
// wrote wrong is named in leftOut.
function wakeupOf(
	message: Record<string, unknown>,
	recipient: string,
	vevent: Vevent,
	change: Change | null,
	leftOut: string[]
): Wakeup {
	const type = typeOf(change);
	// The UID as the calendar knows it, which the contracts take, and as written, which is hashed
	const uid = vevent.parsed.getFirstPropertyValue('uid');
	const writtenUid = writtenValue(vevent.written, 'UID');
	if (typeof uid !== 'string' || uid.length === 0 || writtenUid === null) {
		throw new DeadLetterError('an invitation without UID');
	}
	const id = invitationId(
		vevent,
		writtenUid,
		recipient,
		change?.kind === 'cancelled' ? ['CANCEL'] : []
	);
	const organizer = organizerOf(vevent.parsed, message['senderEmail'], leftOut);
	const start = whenOf(vevent.parsed, 'dtstart', leftOut);
	const end = endOf(vevent.parsed, leftOut);
	// The occurrence an invitation is about, in its zone as its times are
	const occurrence = whenOf(vevent.parsed, 'recurrence-id', leftOut).at;
	// Where a moved meeting was: a time that did not change is where it still is
	const previous =
		change?.kind === 'moved'
			? {
					previous_start: change.start.moved ? change.start.at : start.at,
					previous_end: change.end.moved ? change.end.at : end.at
				}
			: {};
	const title = vevent.parsed.getFirstPropertyValue('summary');
	// What the organizer wrote, as the model is shown it and the journal keeps it
	const shownTitle = typeof title === 'string' ? { title: cut(title, TITLE_MAX) } : {};
	const shownUid = cut(uid, UID_MAX);
	return {
		source: CALENDAR_SOURCE,
		id,
		type,
		recipient: { email: recipient, uuid: null, reason: 'invited' },
		actor: { email: organizer, uuid: null },
		shown: {
			computed: {
				type,
				source: CALENDAR_SOURCE,
				id,
				...(organizer === null ? {} : { actor: organizer }),
				reason: 'invited',
				object: {
					type: 'event',
					start: start.at,
					end: end.at,
					...previous,
					...(organizer === null ? {} : { organizer }),
					...(occurrence === null ? {} : { occurrence })
				}
			},
			// The organizer writes the UID and the zone as much as the title
			untrusted: {
				...shownTitle,
				uid: shownUid,
				...(start.timezone === null ? {} : { timezone: cut(start.timezone, ZONE_MAX) })
			}
		},
		// What the owner's listening journal keeps of it: the meeting, by its UID and its occurrence,
		// and its title and times, its former ones too for a move
		noted: {
			ids: {
				computed: occurrence === null ? {} : { recurrence_id: occurrence },
				untrusted: { uid: shownUid }
			},
			names: { computed: { start: start.at, end: end.at, ...previous }, untrusted: shownTitle }
		},
		// A new title alone waits for the brief, and wakes no turn the meeting would go to
		...(change?.kind === 'renamed'
			? { forBrief: true as const }
			: {
					invitation: {
						uid,
						start: start.at,
						end: end.at,
						timezone: start.timezone,
						...(change === null ? {} : { scope: scopeOf(vevent) })
					}
				})
	};
}

// What a notification of Calendar is to the listener. The fanout carries every tenant's
// invitations: one for an invitee off the instance's mail domain is foreign to it, taken without
// effect, and nothing of it is read, kept or logged, even in the dead letters. A new invitation
// wakes its invitee, and so does a change to the start or the end of a meeting they were already
// invited to, a REQUEST that is no new invitation, unless its VEVENT as changed says they declined
// it; a change of its title alone is kept for their brief; the cancellation of a meeting, of one
// occurrence of its series or of the whole series, a CANCEL, wakes them too, whatever they
// answered it; any other change, a change to a meeting whose VEVENT says they declined it, a reply
// or a counter-proposal is ignored.
function readingOf(message: RabbitMQMessage, deps: WakeDeps): Reading {
	const recipient = addressOf(message['recipientEmail']);
	if (recipient === null || matrixLocalpartOfPrincipal(deps.config, recipient) === null) {
		return { kind: 'foreign' };
	}
	const identity: Identity = { source: CALENDAR_SOURCE, recipients: 1 };
	const method = typeof message['method'] === 'string' ? message['method'].toUpperCase() : null;
	if (method !== 'REQUEST' && method !== 'CANCEL') {
		return { kind: 'ignored', identity, reason: 'no invitation nor change' };
	}
	const leftOut: string[] = [];
	let change: Change | null = method === 'CANCEL' ? { kind: 'cancelled' } : null;
	if (method === 'REQUEST' && message['isNewEvent'] !== true) {
		change = changeOf(message['changes'], leftOut);
		if (change === null) return { kind: 'ignored', identity, reason: 'no change to tell' };
	}
	const type = typeOf(change);
	let wakeup: Wakeup;
	try {
		const vevent = veventOf(message['event']);
		if (
			(change?.kind === 'moved' || change?.kind === 'renamed') &&
			declinedBy(vevent.parsed, recipient)
		) {
			return { kind: 'ignored', identity: { ...identity, type }, reason: 'declined' };
		}
		wakeup = wakeupOf(message, recipient, vevent, change, leftOut);
	} catch (err: unknown) {
		if (!(err instanceof DeadLetterError)) throw err;
		return { kind: 'malformed', identity: { ...identity, type }, reason: err.message };
	}
	if (leftOut.length > 0) {
		// As for the activity exchange: the fields' names, never what the calendar wrote there
		deps.log.warn(
			{ source: CALENDAR_SOURCE, eventId: wakeup.id, fields: leftOut },
			'event fields left out'
		);
	}
	return {
		kind: 'wakeups',
		identity: { ...identity, eventId: wakeup.id, type },
		wakeups: [wakeup],
		leftOut: []
	};
}

// Listens to Calendar's fanout on the instance's own queue, on Calendar's vhost: a new invitation,
// a move or a cancellation wakes its invitee's assistant
export function startCalendarListener(
	deps: WakeDeps,
	source: CalendarSource,
	options: { readonly retryDelayMs?: number } = {}
): Listener {
	return listenOnOwnQueue(
		deps,
		// A fanout routes on no key: one binding takes all
		{ url: source.amqpUrl, name: 'calendar', exchange: CALENDAR_FANOUT, routingKeys: [''] },
		(message) => readingOf(message, deps),
		options
	);
}
