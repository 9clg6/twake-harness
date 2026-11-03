import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { claimJob, deferJob, enqueueJob, failJob, JobNotHeldError } from '../src/jobs/queue.js';
import { startJobWorker, type JobWorker } from '../src/jobs/worker.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';

// Shorter than the handler below, which takes 2.5 s
const LEASE_MS = 1000;
const HANDLER_MS = 2500;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('the lease of a job', () => {
	let h: TestHarness;
	const workers: JobWorker[] = [];
	let runs = 0;
	beforeAll(async () => {
		h = await startTestHarness();
	});
	afterEach(async () => {
		for (const worker of workers.splice(0)) await worker.stop();
		await h.db.sql`delete from jobs`;
		runs = 0;
	});
	afterAll(async () => {
		await h.close();
	});

	// A worker of the matrix role's kinds, whose handler is the test's own
	function startWorker(
		options: { leaseMs?: number; leaseRenewMaxMs?: number; concurrency?: number } = {}
	): JobWorker {
		const worker = startJobWorker({
			db: h.db,
			log: h.app.log,
			kinds: ['send'],
			pollIntervalMs: 100,
			concurrency: 2,
			...options,
			handler: async () => {
				runs += 1;
				await sleep(HANDLER_MS);
				return null;
			}
		});
		workers.push(worker);
		return worker;
	}

	async function untilNoJobLeft(): Promise<void> {
		for (let i = 0; i < 100; i += 1) {
			const rows = await h.db.sql<{ n: number }[]>`select count(*)::int as n from jobs`;
			if ((rows[0]?.n ?? 1) === 0) return;
			await sleep(100);
		}
		throw new Error('the job never ended');
	}

	function logged(since: number, msg: string): Record<string, unknown>[] {
		return h
			.logLines()
			.slice(since)
			.filter((l) => l['msg'] === msg);
	}

	it('is renewed while the handler runs: a job longer than its lease runs once', async () => {
		const since = h.logLines().length;
		startWorker({ leaseMs: LEASE_MS });
		await enqueueJob(h.db, { kind: 'send', payload: {} });
		await untilNoJobLeft();
		expect(runs).toBe(1);
		expect(logged(since, 'jobs requeued after their lease')).toHaveLength(0);
	});

	it('is let go of once renewed for as long as the handler may take, and the run let go of does not end the job', async () => {
		const since = h.logLines().length;
		// A replica that stops renewing is one frozen for good, as far as the others know: another
		// takes the job over, and the first run, once it wakes, finds the job no longer its own
		startWorker({ leaseMs: LEASE_MS, leaseRenewMaxMs: 0, concurrency: 1 });
		await enqueueJob(h.db, { kind: 'send', payload: {} });
		for (let i = 0; runs === 0 && i < 50; i += 1) await sleep(100);
		startWorker({ leaseMs: LEASE_MS });
		await untilNoJobLeft();
		expect(runs).toBe(2);
		expect(logged(since, 'jobs requeued after their lease')).toHaveLength(1);
		expect(logged(since, 'job no longer held')).toHaveLength(1);
	});

	it('answers to its holder alone when deferred or failed, once another took it over', async () => {
		await enqueueJob(h.db, { kind: 'send', payload: {} });
		const first = await claimJob(h.db, ['send'], 'first');
		if (first === null) throw new Error('no job claimed');
		await h.db.sql`update jobs set status = 'queued', locked_by = null where id = ${first.id}`;
		const second = await claimJob(h.db, ['send'], 'second');
		if (second === null) throw new Error('no job claimed again');
		await expect(deferJob(h.db, first.id, first.holder, 1000)).rejects.toBeInstanceOf(
			JobNotHeldError
		);
		await expect(failJob(h.db, first.id, first.holder, 1, 'late', [1000])).rejects.toBeInstanceOf(
			JobNotHeldError
		);
		await expect(failJob(h.db, first.id, first.holder, 2, 'late', [1000])).rejects.toBeInstanceOf(
			JobNotHeldError
		);
		await failJob(h.db, second.id, second.holder, 1, 'its own', [1000]);
		const rows = await h.db.sql<{ status: string }[]>`select status from jobs`;
		expect(rows.map((row) => row.status)).toEqual(['queued']);
	});

	it('is taken over once over, when its holder died without renewing it', async () => {
		const since = h.logLines().length;
		await enqueueJob(h.db, { kind: 'send', payload: {} });
		// Claimed by a replica that is gone, under the default lease, which nothing renews
		await h.db
			.sql`update jobs set status = 'running', locked_by = 'gone', locked_at = now() - interval '1 hour'`;
		startWorker();
		await untilNoJobLeft();
		expect(runs).toBe(1);
		expect(logged(since, 'jobs requeued after their lease')).toHaveLength(1);
	});
});
