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

// The most characters of a title the model is shown: the organizer writes it, at any length, and
// one longer is cut rather than refused
const TITLE_MAX = 1000;

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
function organizerOf(vevent: ICAL.Component, sender: unknown): string | null {
	const written = vevent.getFirstPropertyValue('organizer');
	const organizer =
		typeof written === 'string' ? addressOf(written.trim().replace(/^mailto:/i, '')) : null;
	for (const candidate of [organizer, addressOf(sender)]) {
		if (candidate !== null && EMAIL.safeParse(candidate).success) return candidate;
	}
	return null;
}

// A property's value as the calendar wrote it, escapes included
function written(property: ICAL.Property | null): string | null {
	if (property === null) return null;
	const [, , type, value] = property.toJSON() as [string, unknown, string, unknown];
	return typeof value === 'string'
		? ICAL.stringify.value(value, type, ICAL.design.icalendar, false)
		: null;
}

// One of an invitation's times, as RFC 3339 with the offset of the zone it names, and that zone;
// a date for an all-day event; a time in UTC with its Z; and the wall time as written for a time
// that names no zone, or one that neither the calendar nor the runtime knows
interface When {
	readonly at: string | null;
	readonly timezone: string | null;
}

const NO_TIME: When = { at: null, timezone: null };

function whenOf(vevent: ICAL.Component, name: 'dtstart' | 'dtend'): When {
	const property = vevent.getFirstProperty(name);
	if (property === null) return NO_TIME;
	try {
		const time = property.getFirstValue();
		if (!(time instanceof ICAL.Time)) return NO_TIME;
		if (time.isDate) return { at: time.toString(), timezone: null };
		if (time.zone === ICAL.Timezone.utcTimezone) return { at: time.toString(), timezone: 'UTC' };
		const tzid = property.getParameter('tzid');
		if (typeof tzid !== 'string' || tzid.length === 0) {
			return { at: time.toString(), timezone: null };
		}
		// A zone the calendar does not define is read as the runtime knows it, an IANA name such as
		// Europe/Paris; any other leaves the time floating, its wall time as written
		if (time.zone === ICAL.Timezone.localTimezone) {
			return { at: wallTimeIn(time.toString(), tzid) ?? time.toString(), timezone: tzid };
		}
		// The zone as the calendar defines it, as sabre writes every zone an invitation names
		return { at: `${time.toString()}${formatOffset(time.utcOffset() / 60)}`, timezone: tzid };
	} catch {
		// A time the calendar wrote wrong is no time: the rest of the invitation still counts
		return NO_TIME;
	}
}

// The VEVENT an invitation is about: the first that is no occurrence of a series, which a series'
// own carries, else the first, which an invitation to one occurrence holds alone
function veventOf(text: unknown): ICAL.Component {
	if (typeof text !== 'string') throw new DeadLetterError('a notification without its iCalendar');
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
	const vevent = vevents.find((candidate) => !candidate.hasProperty('recurrence-id')) ?? vevents[0];
	if (vevent === undefined) throw new DeadLetterError('an iCalendar without VEVENT');
	return vevent;
}

// The id the calendar producer gave an invitation, which the gateway's audit records carry and
// tests elsewhere compute again: the hex SHA-256 of its UID as written, its invitee, its SEQUENCE,
// 0 when it has none, and for an occurrence its RECURRENCE-ID as written, joined with |
function invitationId(vevent: ICAL.Component, recipient: string): string {
	const sequence = vevent.getFirstPropertyValue('sequence');
	const occurrence = written(vevent.getFirstProperty('recurrence-id'));
	const parts = [
		written(vevent.getFirstProperty('uid')),
		recipient,
		String(typeof sequence === 'number' ? sequence : 0),
		occurrence
	];
	return createHash('sha256')
		.update(parts.filter((part) => part !== null).join('|'))
		.digest('hex');
}

// The wake-up a notification of Calendar brings its invitee, for a new invitation alone: an update,
// a cancellation or a reply wakes nobody. The fanout carries every tenant's invitations: one for
// an invitee off the instance's mail domain is taken without effect, and nothing of it is read or
// kept, even in the dead letters. What the calendar computed (the UID, the times and their zone,
// the organizer, the occurrence) is shown apart from the title its organizer wrote; the
// description and the location are never read.
function wakeupOf(message: Record<string, unknown>, config: Config): Wakeup | null {
	const method = message['method'];
	if (typeof method !== 'string' || method.toUpperCase() !== 'REQUEST') return null;
	if (message['isNewEvent'] !== true) return null;
	const recipient = addressOf(message['recipientEmail']);
	if (recipient === null || matrixLocalpartOfPrincipal(config, recipient) === null) return null;
	const vevent = veventOf(message['event']);
	const uid = vevent.getFirstPropertyValue('uid');
	if (typeof uid !== 'string' || uid.length === 0) {
		throw new DeadLetterError('an invitation without UID');
	}
	const id = invitationId(vevent, recipient);
	const organizer = organizerOf(vevent, message['senderEmail']);
	const start = whenOf(vevent, 'dtstart');
	const end = whenOf(vevent, 'dtend');
	const occurrence = written(vevent.getFirstProperty('recurrence-id'));
	const title = vevent.getFirstPropertyValue('summary');
	return {
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
					uid,
					start: start.at,
					end: end.at,
					timezone: start.timezone,
					...(organizer === null ? {} : { organizer }),
					...(occurrence === null ? {} : { occurrence })
				}
			},
			untrusted: typeof title === 'string' ? { title: cut(title, TITLE_MAX) } : {}
		},
		invitation: { uid, start: start.at, end: end.at, timezone: start.timezone }
	};
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
			const wakeup = wakeupOf(message, deps.config);
			if (wakeup !== null) await wake(deps, wakeup);
		}
	);
}
