import type { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../app.js';
import type { Config } from '../config.js';
import { startExpiryScheduler } from '../consents/expiry.js';
import { makeConsentMetrics } from '../consents/metrics.js';
import { startCurationScheduler } from '../curation/curation.js';
import type { Db } from '../db/client.js';
import { startActivityListener } from '../wakeups/activity.js';
import { startCalendarListener } from '../wakeups/calendar.js';
import type { Listener } from '../wakeups/listener.js';
import { startWakeupPurgeScheduler } from '../wakeups/retention.js';

export interface WorkerRoleOptions {
	readonly config: Config;
	readonly db: Db;
	readonly logStream?: Writable;
	// The first wait before the listener tries again, a message or to listen, a second unless set
	readonly retryDelayMs?: number;
}

export interface WorkerRole {
	// Serves the health check and the metrics; the API routes stay behind APISIX, which never
	// routes here
	readonly app: FastifyInstance;
	stop(): Promise<void>;
}

// The daily curation, the hourly expiry of the requests nobody answered and the hourly purge of
// the wake-ups past their retention, each starting with a pass at once; the expiries are counted
// on the metrics the role serves. With the activity exchange or Calendar's fanout configured, the
// role also listens to it, and connects to the broker for that alone, once for each.
export async function startWorkerRole(options: WorkerRoleOptions): Promise<WorkerRole> {
	const { config, db } = options;
	const consentMetrics = makeConsentMetrics();
	// The sources it listens to, by the name its health check gives them
	const listeners = new Map<string, Listener>();
	const app = await buildApp({
		config,
		db,
		consentMetrics,
		// Whether it listens, which the check says without failing: a broker down does not restart
		// the role, as the client connects again by itself
		health: () =>
			Object.fromEntries(
				[...listeners].map(([source, listener]) => [
					source,
					listener.connected() ? 'connected' : 'disconnected'
				])
			),
		...(options.logStream === undefined ? {} : { logStream: options.logStream })
	});
	const deps = { config, db, log: app.log };
	const listening =
		options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs };
	if (config.activity !== null) {
		listeners.set('activity', await startActivityListener(deps, config.activity, listening));
	}
	if (config.calendar !== null) {
		listeners.set('calendar', await startCalendarListener(deps, config.calendar, listening));
	}
	const curation = startCurationScheduler(db, app.log, config.curation.intervalMs);
	const expiry = startExpiryScheduler(
		db,
		app.log,
		config.consent.requestLifetimeMs,
		consentMetrics
	);
	const purge = startWakeupPurgeScheduler(db, app.log, config.wakeups.retentionMs);
	return {
		app,
		stop: async () => {
			for (const listener of listeners.values()) await listener.close();
			curation.stop();
			expiry.stop();
			purge.stop();
			await app.close();
		}
	};
}
