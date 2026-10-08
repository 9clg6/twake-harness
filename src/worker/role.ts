import type { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';

import { SYSTEM_CLOCK, type Clock } from '../agent/clock.js';
import { buildApp } from '../app.js';
import { startBriefScheduler } from '../briefs/schedule.js';
import type { Config } from '../config.js';
import { startExpiryScheduler } from '../consents/expiry.js';
import { makeConsentMetrics } from '../consents/metrics.js';
import { startReminderScheduler } from '../consents/reminder.js';
import { startCurationScheduler } from '../curation/curation.js';
import type { Db } from '../db/client.js';
import { startSuggestionPurgeScheduler } from '../suggestions/retention.js';
import { startActivityListener } from '../wakeups/activity.js';
import { startCalendarListener } from '../wakeups/calendar.js';
import type { Listener } from '../wakeups/listener.js';
import { startWakeupPurgeScheduler } from '../wakeups/retention.js';

// How often the role looks whether the hour of the daily reminders has come
const REMINDER_CHECK_MS = 60_000;
// How often the role looks whose brief of their working day is due
const BRIEF_CHECK_MS = 60_000;

export interface WorkerRoleOptions {
	readonly config: Config;
	readonly db: Db;
	readonly logStream?: Writable;
	// The first wait before the listener tries again, a message or to listen, a second unless set
	readonly retryDelayMs?: number;
	// The present the daily reminders and the briefs read, the system clock unless set
	readonly clock?: Clock;
	// How often the role looks whether their hour has come, a minute unless set
	readonly reminderCheckMs?: number;
	// How often the role looks whose brief is due, a minute unless set
	readonly briefCheckMs?: number;
}

export interface WorkerRole {
	// Serves the health check and the metrics; the API routes stay behind APISIX, which never
	// routes here
	readonly app: FastifyInstance;
	stop(): Promise<void>;
}

// The daily curation, the hourly expiry of the requests nobody answered, the hourly purges of the
// wake-ups past their retention and of the suggestions nothing reads any more, each starting with
// a pass at once, the daily reminders of the permissions about to expire, at their hour, and the
// briefs of the owners' working days, from eight in their zones; the expiries are counted on the
// metrics the role serves. With the activity exchange or Calendar's fanout configured, the role
// also listens to it, and connects to the broker for that alone, once for each.
export async function startWorkerRole(options: WorkerRoleOptions): Promise<WorkerRole> {
	const { config, db } = options;
	const clock = options.clock ?? SYSTEM_CLOCK;
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
		listeners.set('activity', startActivityListener(deps, config.activity, listening));
	}
	if (config.calendar !== null) {
		listeners.set('calendar', startCalendarListener(deps, config.calendar, listening));
	}
	const curation = startCurationScheduler(db, app.log, config.curation.intervalMs);
	const expiry = startExpiryScheduler(
		db,
		app.log,
		config.consent.requestLifetimeMs,
		consentMetrics
	);
	const purge = startWakeupPurgeScheduler(db, app.log, config.wakeups.retentionMs);
	const suggestionPurge = startSuggestionPurgeScheduler(
		db,
		app.log,
		config.consent.requestLifetimeMs
	);
	const reminders = startReminderScheduler(
		{ ...deps, clock },
		options.reminderCheckMs ?? REMINDER_CHECK_MS
	);
	const briefs = startBriefScheduler({ ...deps, clock }, options.briefCheckMs ?? BRIEF_CHECK_MS);
	return {
		app,
		stop: async () => {
			for (const listener of listeners.values()) await listener.close();
			curation.stop();
			expiry.stop();
			purge.stop();
			suggestionPurge.stop();
			await reminders.stop();
			await briefs.stop();
			await app.close();
		}
	};
}
