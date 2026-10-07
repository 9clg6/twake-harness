import { createHash } from 'node:crypto';
import { DeadLetterError } from '@linagora/rabbitmq-client';
import ICAL from 'ical.js';
import { z } from 'zod';

import { formatOffset, wallTimeIn } from '../agent/clock.js';
import type { CalendarSource, Config } from '../config.js';
import { cut } from '../llm/data.js';
import { matrixLocalpartOfPrincipal } from '../principals/identity.js';
import { INVITED_EVENT_TYPE } from './event-types.js';
import { listenOnOwnQueue, type Listener } from './listener.js';
import { wake, type WakeDeps, type Wakeup } from './wake.js';

// Where Calendar's side service sends a notification for each invitee of each change to a
// meeting, on Calendar's own vhost: a fanout, which gives every queue bound to it every message.
// The invitations of personal calendars never reach the activity exchange.
const CALENDAR_FANOUT = 'calendar:event:notificationEmail:send';

// The source the calendar producer gave the invitations it published, which wake-ups are kept by
const SOURCE = 'twake://calendar';

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

// The organizer of an invitation: its ORGANIZER without mailto:, or the sender of the notification
// when it names none; whichever is an email address, so that nothing else passes for what the
// calendar computed
function organizerOf(vevent: ICAL.Component, sender: unknown, leftOut: string[]): string | null {
	const written = vevent.getFirstPropertyValue('organizer');
	const organizer =
		typeof written === 'string' ? addressOf(written.trim().replace(/^mailto:/i, '')) : null;
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
// when it has none, and for an occurrence its RECURRENCE-ID exactly as written, joined with |
function invitationId(vevent: Vevent, uid: string, recipient: string): string {
	const sequence = vevent.parsed.getFirstPropertyValue('sequence');
	const occurrence = writtenValue(vevent.written, 'RECURRENCE-ID');
	const parts = [
		uid,
		recipient,
		String(typeof sequence === 'number' ? sequence : 0),
		...(occurrence === null ? [] : [occurrence])
	];
	return createHash('sha256').update(parts.join('|')).digest('hex');
}

// A new invitation as the harness read it: its wake-up, and the fields the calendar wrote wrong,
// which were left out, by their names
interface Read {
	readonly wakeup: Wakeup;
	readonly leftOut: readonly string[];
}

// The wake-up a notification of Calendar brings its invitee, for a new invitation alone: an update,
// a cancellation or a reply wakes nobody. The fanout carries every tenant's invitations: one for
// an invitee off the instance's mail domain is taken without effect, and nothing of it is read or
// kept, even in the dead letters. What the calendar computed (the times, the organizer's address
// and the occurrence) is shown apart from what the organizer wrote (the title, the UID and the
// zone, under untrusted); the description and the location are never read. The check takes the
// UID and the zone whole.
function wakeupOf(message: Record<string, unknown>, config: Config): Read | null {
	const method = message['method'];
	if (typeof method !== 'string' || method.toUpperCase() !== 'REQUEST') return null;
	if (message['isNewEvent'] !== true) return null;
	const recipient = addressOf(message['recipientEmail']);
	if (recipient === null || matrixLocalpartOfPrincipal(config, recipient) === null) return null;
	const vevent = veventOf(message['event']);
	// The UID as the calendar knows it, which the contracts take, and as written, which is hashed
	const uid = vevent.parsed.getFirstPropertyValue('uid');
	const writtenUid = writtenValue(vevent.written, 'UID');
	if (typeof uid !== 'string' || uid.length === 0 || writtenUid === null) {
		throw new DeadLetterError('an invitation without UID');
	}
	const id = invitationId(vevent, writtenUid, recipient);
	const leftOut: string[] = [];
	const organizer = organizerOf(vevent.parsed, message['senderEmail'], leftOut);
	const start = whenOf(vevent.parsed, 'dtstart', leftOut);
	const end = endOf(vevent.parsed, leftOut);
	// The occurrence an invitation is about, in its zone as its times are
	const occurrence = whenOf(vevent.parsed, 'recurrence-id', leftOut).at;
	const title = vevent.parsed.getFirstPropertyValue('summary');
	const wakeup: Wakeup = {
		source: SOURCE,
		id,
		type: INVITED_EVENT_TYPE,
		recipient: { email: recipient, uuid: null, reason: 'invited' },
		actor: { email: organizer, uuid: null },
		shown: {
			computed: {
				type: INVITED_EVENT_TYPE,
				source: SOURCE,
				id,
				...(organizer === null ? {} : { actor: organizer }),
				reason: 'invited',
				object: {
					type: 'event',
					start: start.at,
					end: end.at,
					...(organizer === null ? {} : { organizer }),
					...(occurrence === null ? {} : { occurrence })
				}
			},
			// The organizer writes the UID and the zone as much as the title
			untrusted: {
				...(typeof title === 'string' ? { title: cut(title, TITLE_MAX) } : {}),
				uid: cut(uid, UID_MAX),
				...(start.timezone === null ? {} : { timezone: cut(start.timezone, ZONE_MAX) })
			}
		},
		invitation: { uid, start: start.at, end: end.at, timezone: start.timezone }
	};
	return { wakeup, leftOut };
}

// Listens to Calendar's fanout on the instance's own queue, on Calendar's vhost: a new invitation
// wakes its invitee's assistant
export async function startCalendarListener(
	deps: WakeDeps,
	source: CalendarSource
): Promise<Listener> {
	return listenOnOwnQueue(
		deps,
		// A fanout routes on no key: one binding takes all
		{ url: source.amqpUrl, name: 'calendar', exchange: CALENDAR_FANOUT, routingKeys: [''] },
		async (message) => {
			const read = wakeupOf(message, deps.config);
			if (read === null) return;
			const { wakeup, leftOut } = read;
			if (leftOut.length > 0) {
				// As for the activity exchange: the fields' names, never what the calendar wrote there
				deps.log.warn(
					{ source: SOURCE, eventId: wakeup.id, fields: leftOut },
					'event fields left out'
				);
			}
			await wake(deps, wakeup);
		}
	);
}
