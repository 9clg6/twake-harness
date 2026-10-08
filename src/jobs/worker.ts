import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';

import type { Db } from '../db/client.js';
import {
	claimJob,
	completeJob,
	deferJob,
	failJob,
	requeueDeferredJobs,
	requeueStaleJobs,
	retryDelaysOf,
	type Job,
	type JobKind,
	type RetryDelays
} from './queue.js';

// What a handler asks of a job it could not run yet: to be tried again after a while, out of its
// group's way meanwhile
export interface Deferral {
	readonly retryInMs: number;
}

export interface JobWorkerOptions {
	readonly db: Db;
	readonly kinds: readonly JobKind[];
	// Resolves once the job is done, to null, or to a deferral when it could not run yet. A handler
	// whose work must end with its job, all or nothing, may complete the job itself in the
	// transaction of that work and resolve to null: the worker's completion then finds nothing left.
	readonly handler: (job: Job) => Promise<Deferral | null>;
	// What ends a job that failed for good, once it is marked so: whatever it settles is settled
	// whether or not the handler got that far
	readonly failedForGood?: (job: Job) => Promise<void>;
	readonly log: FastifyBaseLogger;
	readonly pollIntervalMs?: number;
	// How long a job that failed waits before each of its next tries, by kind, over the queue's: a
	// test makes a revocation's short
	readonly retryDelaysMs?: Partial<Record<JobKind, RetryDelays>>;
	readonly concurrency?: number;
	// How long a claimed job may run before another replica assumes its holder is gone
	readonly leaseMs?: number;
}

// Longer than any turn: the model timeout times the tool calls a turn may make
export const DEFAULT_LEASE_MS = 15 * 60 * 1000;

export interface JobWorker {
	stop(): Promise<void>;
}

// Polls the queue and runs jobs up to a concurrency; a failing job is tried again after the waits of
// its kind, and a deferred one once due.
export function startJobWorker(options: JobWorkerOptions): JobWorker {
	const workerId = randomUUID();
	const interval = options.pollIntervalMs ?? 500;
	const concurrency = options.concurrency ?? 4;
	const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
	let running = 0;
	let stopped = false;
	let timer: NodeJS.Timeout | null = null;
	// The poll under way, if any: a stop waits for it, since it may be about to claim a job
	let polling: Promise<void> | null = null;
	const inflight = new Set<Promise<void>>();

	async function runOne(job: Job): Promise<void> {
		try {
			const deferral = await options.handler(job);
			if (deferral === null) await completeJob(options.db, job.id);
			else await deferJob(options.db, job.id, deferral.retryInMs);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			options.log.error({ job: job.id, kind: job.kind, attempts: job.attempts, err }, 'job failed');
			const delaysMs = options.retryDelaysMs?.[job.kind] ?? retryDelaysOf(job.kind);
			const forGood = await failJob(options.db, job.id, job.attempts, message, delaysMs).catch(
				() => false
			);
			if (forGood && options.failedForGood !== undefined) {
				await options
					.failedForGood(job)
					.catch((failure: unknown) =>
						options.log.error({ job: job.id, kind: job.kind, err: failure }, 'job end failed')
					);
			}
		}
	}

	async function tick(): Promise<void> {
		if (stopped) return;
		try {
			const requeued = await requeueStaleJobs(options.db, leaseMs);
			if (requeued > 0) options.log.warn({ requeued }, 'jobs requeued after their lease');
			await requeueDeferredJobs(options.db, options.kinds);
			// Once stopped, nothing new is claimed; a job the poll already holds still runs to its end
			while (!stopped && running < concurrency) {
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
		if (!stopped) timer = setTimeout(poll, interval);
	}

	function poll(): void {
		polling = tick();
	}

	poll();
	return {
		stop: async () => {
			stopped = true;
			if (timer !== null) clearTimeout(timer);
			if (polling !== null) await polling;
			await Promise.allSettled([...inflight]);
		}
	};
}
