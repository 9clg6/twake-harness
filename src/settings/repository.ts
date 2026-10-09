import { findTimeZone, type TimeZone, type Weekday } from '../agent/clock.js';
import type { Tx } from '../db/client.js';

// The zone of the owner's calendar, as a calendar read last returned it; null before any did
export async function findOwnerTimeZone(tx: Tx, owner: string): Promise<TimeZone | null> {
	return (await findOwnerSettings(tx, owner)).timeZone;
}

// Keeps the zone a calendar read returned, in place of the one before
export async function saveOwnerTimeZone(tx: Tx, owner: string, timeZone: TimeZone): Promise<void> {
	await tx.sql`
		insert into owner_settings (owner, time_zone) values (${owner}, ${timeZone})
		on conflict (owner) do update set time_zone = excluded.time_zone`;
}

// What an owner chose of their morning brief, null where they kept the default
export interface BriefChoices {
	// The time it is due, in minutes after midnight on their wall clock, on the quarter hour
	readonly time: number | null;
	// The days of the week it goes out, in the order of the week, one at least
	readonly days: readonly Weekday[] | null;
	// The date it goes out again after a pause, as dateIn gives it; none before it
	readonly pausedUntil: string | null;
	// Whether they stopped it, until they resume it
	readonly stopped: boolean;
}

// An owner's settings: the zone of their calendar, null before a read of it named one, and what
// they chose of their brief
export interface OwnerSettings {
	readonly timeZone: TimeZone | null;
	readonly brief: BriefChoices;
}

interface OwnerSettingsRow {
	readonly time_zone: string | null;
	readonly brief_time: number | null;
	readonly brief_days: Weekday[] | null;
	readonly brief_paused_until: string | null;
	readonly brief_stopped: boolean;
}

export async function findOwnerSettings(tx: Tx, owner: string): Promise<OwnerSettings> {
	const rows = await tx.sql<OwnerSettingsRow[]>`
		select time_zone, brief_time, brief_days, brief_paused_until::text as brief_paused_until,
			brief_stopped
		from owner_settings where owner = ${owner}`;
	const row = rows[0];
	const zone = row?.time_zone ?? null;
	return {
		// A zone the runtime no longer knows falls back to the deployment's, as if none were kept
		timeZone: zone === null ? null : findTimeZone(zone),
		brief: {
			time: row?.brief_time ?? null,
			days: row?.brief_days ?? null,
			pausedUntil: row?.brief_paused_until ?? null,
			stopped: row?.brief_stopped ?? false
		}
	};
}

// Keeps what an owner chose of their brief, in place of what they chose before, their zone kept
export async function saveBriefChoices(tx: Tx, owner: string, brief: BriefChoices): Promise<void> {
	const days = brief.days === null ? null : [...brief.days];
	await tx.sql`
		insert into owner_settings (owner, brief_time, brief_days, brief_paused_until, brief_stopped)
		values (${owner}, ${brief.time}, ${days}, ${brief.pausedUntil}, ${brief.stopped})
		on conflict (owner) do update set
			brief_time = excluded.brief_time,
			brief_days = excluded.brief_days,
			brief_paused_until = excluded.brief_paused_until,
			brief_stopped = excluded.brief_stopped`;
}
