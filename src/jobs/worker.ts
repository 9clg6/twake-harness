import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';

import type { Db } from '../db/client.js';
import {
	claimJob,
	completeJob,
	deferJob,
	failJob,
	JobNotHeldError,
	renewLease,
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
	// How long a claimed job may go without its holder renewing the claim before another replica
	// assumes that holder is gone
	readonly leaseMs?: number;
	// How long a holder renews its claim on a job at most: past it, the job is let go of as one
	// whose holder is gone, and another replica takes it over, so that a handler that hangs for
	// good holds no job for ever. A turn is given the longest it can take.
	readonly leaseRenewMaxMs?: number;
}

// How long a replica may stay silent on a job it runs: its claim is renewed a third of this at a
// time, so only a replica that is gone, or frozen, lets it run out
export const DEFAULT_LEASE_MS = 15 * 60 * 1000;
export const DEFAULT_LEASE_RENEW_MAX_MS = 4 * DEFAULT_LEASE_MS;

export interface JobWorker {
	stop(): Promise<void>;
	// Runs one job through the worker's own handler, without claiming it: a test driving the deferral
	// of a job by hand, so that how many passes it takes never depends on the host's speed
	pass(job: Job): Promise<void>;
}

// Polls the queue and runs jobs up to a concurrency; a failing job is tried again after the waits of
// its kind, and a deferred one once due.
export function startJobWorker(options: JobWorkerOptions): JobWorker {
	const workerId = randomUUID();
	const interval = options.pollIntervalMs ?? 500;
	const concurrency = options.concurrency ?? 4;
	const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
	const renewMaxMs = options.leaseRenewMaxMs ?? DEFAULT_LEASE_RENEW_MAX_MS;
	let running = 0;
	let stopped = false;
	let timer: NodeJS.Timeout | null = null;
	// The poll under way, if any: a stop waits for it, since it may be about to claim a job
	let polling: Promise<void> | null = null;
	const inflight = new Set<Promise<void>>();

	async function runOne(job: Job): Promise<void> {
		// The claim is renewed while the handler runs, well within the lease, for as long as the
		// handler may take: a job that outlives the lease, as a turn of many slow model calls does, is
		// not taken for one whose holder is gone and run a second time beside the first
		const claimed = Date.now();
		const heartbeat = setInterval(() => {
			if (Date.now() - claimed > renewMaxMs) {
				clearInterval(heartbeat);
				options.log.warn({ job: job.id, kind: job.kind, renewMaxMs }, 'job lease let go');
				return;
			}
			renewLease(options.db, job.id, job.holder).catch((err: unknown) => {
				options.log.warn({ job: job.id, kind: job.kind, err }, 'job lease not renewed');
			});
		}, leaseMs / 3);
		try {
			const deferral = await options.handler(job);
			if (deferral === null) await completeJob(options.db, job.id, job.holder);
			else await deferJob(options.db, job.id, job.holder, deferral.retryInMs);
		} catch (err: unknown) {
			// Taken over by another worker meanwhile: what this one did with it does not count
			if (err instanceof JobNotHeldError) {
				options.log.warn({ job: job.id, kind: job.kind, holder: job.holder }, 'job no longer held');
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			options.log.error({ job: job.id, kind: job.kind, attempts: job.attempts, err }, 'job failed');
			const delaysMs = options.retryDelaysMs?.[job.kind] ?? retryDelaysOf(job.kind);
			const forGood = await failJob(
				options.db,
				job.id,
				job.holder,
				job.attempts,
				message,
				delaysMs
			).catch((failure: unknown) => {
				if (failure instanceof JobNotHeldError) {
					options.log.warn(
						{ job: job.id, kind: job.kind, holder: job.holder },
						'job no longer held'
					);
				} else {
					options.log.error({ job: job.id, kind: job.kind, err: failure }, 'job end failed');
				}
				return false;
			});
			if (forGood && options.failedForGood !== undefined) {
				await options
					.failedForGood(job)
					.catch((failure: unknown) =>
						options.log.error({ job: job.id, kind: job.kind, err: failure }, 'job end failed')
					);
			}
		} finally {
			clearInterval(heartbeat);
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
				// A token per claim: a job this worker claims again, once its lease ran out, no longer
				// answers to the run that let it go
				const job = await claimJob(options.db, options.kinds, `${workerId}:${randomUUID()}`);
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
		},
		pass: runOne
	};
}
