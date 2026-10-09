import type { FastifyBaseLogger } from 'fastify';

import type { Clock } from '../agent/clock.js';
import { withPrincipal, type Db } from '../db/client.js';
import { HOUR_MS } from '../wakeups/retention.js';
import { purgeActivities, type Purged } from './repository.js';

// How long a listening journal keeps the names of an activity, its title and its times: a week
const NAMES_KEPT_MS = 7 * 24 * HOUR_MS;

// Erases the names of the activities older than a week from every owner's listening journal, and
// deletes those older than the wake-ups' retention, so that no replay finds them gone while a
// wake-up remembers it: a pass of the worker role over every owner, each owner's rows touched under
// their own principal. Logs how many of each, and resolves to that.
export async function purgeListeningJournals(
	db: Db,
	log: FastifyBaseLogger,
	retentionMs: number,
	clock: Clock
): Promise<Purged> {
	const now = clock.now().getTime();
	const before = { names: new Date(now - NAMES_KEPT_MS), rows: new Date(now - retentionMs) };
	const owners = (
		await db.sql<{ owner: string }[]>`select owner from principal_index order by owner`
	).map((r) => r.owner);
	let erased = 0;
	let purged = 0;
	for (const owner of owners) {
		try {
			const counts = await withPrincipal(db, { id: owner }, (tx) =>
				purgeActivities(tx, owner, before)
			);
			erased += counts.erased;
			purged += counts.purged;
		} catch (err: unknown) {
			log.error({ owner, err }, 'listening journal purge of an owner failed');
		}
	}
	if (erased > 0 || purged > 0) log.info({ erased, purged }, 'listening journal purged');
	return { erased, purged };
}

export interface ListeningJournalPurgeScheduler {
	stop(): void;
}

// A purge at once, then every hour, on the clock the activities were noted by
export function startListeningJournalPurgeScheduler(
	db: Db,
	log: FastifyBaseLogger,
	retentionMs: number,
	clock: Clock
): ListeningJournalPurgeScheduler {
	const tick = (): void => {
		void purgeListeningJournals(db, log, retentionMs, clock).catch((err: unknown) =>
			log.error({ err }, 'listening journal purge failed')
		);
	};
	tick();
	const timer = setInterval(tick, HOUR_MS);
	return {
		stop: () => {
			clearInterval(timer);
		}
	};
}
