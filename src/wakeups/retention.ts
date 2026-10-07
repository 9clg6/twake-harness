import type { FastifyBaseLogger } from 'fastify';

import type { Db } from '../db/client.js';

// How often the worker role forgets the wake-ups past their retention
const PURGE_INTERVAL_MS = 3_600_000;

// Forgets the wake-ups older than the retention, so that the table holds what a redelivery or a
// replay of the dead letter queue may still bring back, and no more. Resolves to how many went.
export async function purgeWakeups(db: Db, retentionMs: number): Promise<number> {
	const purged = await db.sql`
		delete from wakeups where woken_at < now() - make_interval(secs => ${retentionMs / 1000})`;
	return purged.count;
}

export interface WakeupPurge {
	stop(): void;
}

// A purge at once, then every hour
export function startWakeupPurge(db: Db, log: FastifyBaseLogger, retentionMs: number): WakeupPurge {
	const tick = (): void => {
		void purgeWakeups(db, retentionMs)
			.then((purged) => {
				if (purged > 0) log.info({ purged }, 'wake-ups purged');
			})
			.catch((err: unknown) => log.error({ err }, 'wake-up purge failed'));
	};
	tick();
	const timer = setInterval(tick, PURGE_INTERVAL_MS);
	return {
		stop: () => {
			clearInterval(timer);
		}
	};
}
