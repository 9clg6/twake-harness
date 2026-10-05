import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';

import type { Db } from '../db/client.js';
import { claimJob, completeJob, failJob, type Job, type JobKind } from './queue.js';

export interface JobWorkerOptions {
	readonly db: Db;
	readonly kinds: readonly JobKind[];
	readonly handler: (job: Job) => Promise<void>;
	readonly log: FastifyBaseLogger;
	readonly pollIntervalMs?: number;
	readonly concurrency?: number;
}

export interface JobWorker {
	stop(): Promise<void>;
}

// Polls the queue and runs jobs up to a concurrency; a failing job is retried with a backoff.
export function startJobWorker(options: JobWorkerOptions): JobWorker {
	const workerId = randomUUID();
	const interval = options.pollIntervalMs ?? 500;
	const concurrency = options.concurrency ?? 4;
	let running = 0;
	let stopped = false;
	let timer: NodeJS.Timeout | null = null;
	const inflight = new Set<Promise<void>>();

	async function runOne(job: Job): Promise<void> {
		try {
			await options.handler(job);
			await completeJob(options.db, job.id);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			options.log.error({ job: job.id, kind: job.kind, attempts: job.attempts, err }, 'job failed');
			await failJob(options.db, job.id, job.attempts, message).catch(() => undefined);
		}
	}

	async function tick(): Promise<void> {
		if (stopped) return;
		try {
			while (running < concurrency) {
				const job = await claimJob(options.db, options.kinds, workerId);
				if (job === null) break;
				running += 1;
				const task = runOne(job).finally(() => {
					running -= 1;
					inflight.delete(task);
				});
				inflight.add(task);
			}
		} catch (err: unknown) {
			options.log.warn({ err }, 'job poll failed');
		}
		if (!stopped) timer = setTimeout(() => void tick(), interval);
	}

	void tick();
	return {
		stop: async () => {
			stopped = true;
			if (timer !== null) clearTimeout(timer);
			await Promise.allSettled([...inflight]);
		}
	};
}
