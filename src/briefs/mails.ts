import { z } from 'zod';

import { isoIn, wallTimeIn, weekdayOf } from '../agent/clock.js';
import type { BriefSettings } from './settings.js';

// The most unread emails of the owner's inbox the brief reads, and so the most the model is handed
export const MAX_MAILS = 50;

// One email of the owner's as Mail lists it: what Mail computed, whether it was sent in bulk and
// whether the owner is among its recipients in To included, then, under untrusted, what its sender
// wrote
const emailSchema = z.object({
	id: z.string(),
	thread_id: z.string(),
	mailbox_ids: z.array(z.string()),
	received_at: z.string(),
	unread: z.boolean(),
	flagged: z.boolean(),
	has_attachment: z.boolean(),
	bulk: z.boolean(),
	to_me: z.boolean(),
	untrusted: z.object({
		from: z.array(z.object({ name: z.string().nullable(), email: z.string().nullable() })),
		subject: z.string(),
		preview: z.string()
	})
});

export type Email = z.infer<typeof emailSchema>;

// Who sent an email, as its sender wrote it
export type Sender = Email['untrusted']['from'][number];

// What Mail lists of the owner's emails, newest first, and the cursor of those that follow, if any
export const emailListSchema = z.object({
	emails: z.array(emailSchema),
	next_cursor: z.string().nullable()
});

// The owner's own mailboxes, the special ones named by their role, such as inbox
export const mailboxListSchema = z.object({
	mailboxes: z.array(z.object({ id: z.string(), role: z.string().nullish() }))
});

// The owner's unread mail as the brief tells it: the instant it is read from, in the zone of their
// calendar, the emails Mail listed since then but those sent in bulk, in the order the harness lays
// them out, whether Mail had more, and the people of the day's meetings, whose emails count
export interface Mails {
	readonly since: string;
	readonly unread: readonly Email[];
	readonly truncated: boolean;
	readonly participants: readonly string[];
}

// The day some days before a date, both as dateIn writes them
function dayBefore(date: string, days: number): string {
	return new Date(Date.parse(`${date}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

// The instant the brief reads the owner's unread mail from: when their last brief read it. Before
// any did, or when that is not before now, as a clock set back would leave it, the same time of
// their wall clock on the last day before today of those their brief goes out on.
export function mailsSince(readAt: Date | null, now: Date, settings: BriefSettings): Date {
	if (readAt !== null && readAt.getTime() < now.getTime()) return readAt;
	const wall = isoIn(now, settings.timeZone);
	const today = wall.slice(0, 10);
	const back =
		[1, 2, 3, 4, 5, 6, 7].find((days) =>
			settings.days.includes(weekdayOf(dayBefore(today, days)))
		) ?? 1;
	const at = wallTimeIn(`${dayBefore(today, back)}T${wall.slice(11, 19)}`, settings.timeZone);
	return at === null ? new Date(now.getTime() - back * 86_400_000) : new Date(at);
}

// The emails in the order the harness lays them out: flagged ones first, then those sent to the
// owner, then the latest
export function byImportance(a: Email, b: Email): number {
	if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
	if (a.to_me !== b.to_me) return a.to_me ? -1 : 1;
	return Date.parse(b.received_at) - Date.parse(a.received_at);
}

// The addresses of the people the day's meetings name, the owner's left out, each once, in lower
// case: their organizers, the one address a list of meetings gives
export function participantsOf(organizers: readonly (string | null)[], owner: string): string[] {
	const addresses = organizers.flatMap((organizer) =>
		organizer === null ? [] : [organizer.toLowerCase()]
	);
	return [...new Set(addresses)].filter((address) => address !== owner.toLowerCase());
}
