import type { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../app.js';
import type { Config } from '../config.js';
import { startExpiryScheduler } from '../consents/expiry.js';
import { makeConsentMetrics } from '../consents/metrics.js';
import { startCurationScheduler } from '../curation/curation.js';
import type { Db } from '../db/client.js';
import { startActivityListener, type ActivityListener } from '../wakeups/activity.js';
import { startCalendarListener, type CalendarListener } from '../wakeups/calendar.js';

export interface WorkerRoleOptions {
	readonly config: Config;
	readonly db: Db;
	readonly logStream?: Writable;
}

export interface WorkerRole {
	// Serves the health check and the metrics; the API routes stay behind APISIX, which never
	// routes here
	readonly app: FastifyInstance;
	stop(): Promise<void>;
}

// The daily curation and the hourly expiry of the requests nobody answered, each starting with a
// pass at once; the expiries are counted on the metrics the role serves. With the activity
// exchange or Calendar's fanout configured, the role also listens to it, and connects to the
// broker for that alone, once for each.
export async function startWorkerRole(options: WorkerRoleOptions): Promise<WorkerRole> {
	const { config, db } = options;
	const consentMetrics = makeConsentMetrics();
	let activity: ActivityListener | null = null;
	let calendar: CalendarListener | null = null;
	const app = await buildApp({
		config,
		db,
		consentMetrics,
		// Whether it listens, which the check says without failing: a broker down does not restart
		// the role, as the client connects again by itself
		health: () => ({
			...(activity === null
				? {}
				: { activity: activity.connected() ? 'connected' : 'disconnected' }),
			...(calendar === null
				? {}
				: { calendar: calendar.connected() ? 'connected' : 'disconnected' })
		}),
		...(options.logStream === undefined ? {} : { logStream: options.logStream })
	});
	if (config.activity !== null) {
		activity = await startActivityListener({ config, db, log: app.log }, config.activity);
	}
	if (config.calendar !== null) {
		calendar = await startCalendarListener({ config, db, log: app.log }, config.calendar);
	}
	const curation = startCurationScheduler(db, app.log, config.curation.intervalMs);
	const expiry = startExpiryScheduler(
		db,
		app.log,
		config.consent.requestLifetimeMs,
		consentMetrics
	);
	return {
		app,
		stop: async () => {
			await activity?.close();
			await calendar?.close();
			curation.stop();
			expiry.stop();
			await app.close();
		}
	};
}
