import { findTimeZone, type TimeZone } from '../agent/clock.js';
import type { Tx } from '../db/client.js';

// The zone of the owner's calendar, as a calendar read last returned it; null before any did
export async function findOwnerTimeZone(tx: Tx, owner: string): Promise<TimeZone | null> {
	const rows = await tx.sql<{ time_zone: string | null }[]>`
		select time_zone from owner_settings where owner = ${owner}`;
	const zone = rows[0]?.time_zone ?? null;
	// A zone the runtime no longer knows falls back to the deployment's, as if none were kept
	return zone === null ? null : findTimeZone(zone);
}

// Keeps the zone a calendar read returned, in place of the one before
export async function saveOwnerTimeZone(tx: Tx, owner: string, timeZone: TimeZone): Promise<void> {
	await tx.sql`
		insert into owner_settings (owner, time_zone) values (${owner}, ${timeZone})
		on conflict (owner) do update set time_zone = excluded.time_zone`;
}
