import type { FastifyBaseLogger } from 'fastify';

import type { Db } from '../db/client.js';

// An hour, in milliseconds
export const HOUR_MS = 3_600_000;

// Forgets the wake-ups older than the retention, so that the table holds what a redelivery or a
// replay of the dead letter queue may still bring back, and no more, and logs how many went.
// Resolves to how many went.
export async function purgeWakeups(
	db: Db,
	log: FastifyBaseLogger,
	retentionMs: number
): Promise<number> {
	const purged = await db.sql`
		delete from wakeups where woken_at < now() - make_interval(secs => ${retentionMs / 1000})`;
	if (purged.count > 0) log.info({ purged: purged.count }, 'wake-ups purged');
	return purged.count;
}

export interface WakeupPurgeScheduler {
	stop(): void;
}

// A purge at once, then every hour
export function startWakeupPurgeScheduler(
	db: Db,
	log: FastifyBaseLogger,
	retentionMs: number
): WakeupPurgeScheduler {
	const tick = (): void => {
		void purgeWakeups(db, log, retentionMs).catch((err: unknown) =>
			log.error({ err }, 'wake-up purge failed')
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
