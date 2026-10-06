import type { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../app.js';
import type { Config } from '../config.js';
import { startExpiryScheduler } from '../consents/expiry.js';
import { makeConsentMetrics } from '../consents/metrics.js';
import { startCurationScheduler } from '../curation/curation.js';
import type { Db } from '../db/client.js';

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
// pass at once; the expiries are counted on the metrics the role serves
export async function startWorkerRole(options: WorkerRoleOptions): Promise<WorkerRole> {
	const { config, db } = options;
	const consentMetrics = makeConsentMetrics();
	const app = await buildApp({
		config,
		db,
		consentMetrics,
		...(options.logStream === undefined ? {} : { logStream: options.logStream })
	});
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
			curation.stop();
			expiry.stop();
			await app.close();
		}
	};
}
