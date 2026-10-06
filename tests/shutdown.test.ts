import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeDb, type Db } from '../src/db/client.js';
import { enqueueJob } from '../src/jobs/queue.js';
import { startJobWorker } from '../src/jobs/worker.js';
import { startTestHarness, TEST_DATABASE_URL, type TestHarness } from './helpers/app.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HeldLock {
	release(): Promise<void>;
}

// Holds an exclusive lock on a table from another connection, so that background work reaching
// that table waits in the middle of a query: the window a shutdown must not leave behind
async function lockTable(table: 'jobs'): Promise<HeldLock> {
	const locker: Db = makeDb(TEST_DATABASE_URL);
	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let taken: () => void = () => undefined;
	const lockTaken = new Promise<void>((resolve) => {
		taken = resolve;
	});
	const holder = locker.sql.begin(async (sql) => {
		await sql.unsafe(`lock table ${table} in access exclusive mode`);
		taken();
		await held;
	});
	await lockTaken;
	return {
		release: async () => {
			release();
			await holder;
			await locker.close();
		}
	};
}

// Whether a promise settles within a delay, without waiting for it beyond that
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		}
	);
	await sleep(ms);
	return settled;
}

describe('stopping a job worker', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness();
	});
	afterAll(async () => {
		if (h !== undefined) await h.close();
	});

	it('lets the poll in flight finish, and claims nothing once stopped', async () => {
		await enqueueJob(h.db, { kind: 'send', payload: {}, dedupKey: 'shutdown:job' });
		const lock = await lockTable('jobs');
		const handled: number[] = [];
		const worker = startJobWorker({
			db: h.db,
			kinds: ['send'],
			log: h.app.log,
			pollIntervalMs: 20,
			handler: async (job) => {
				handled.push(job.id);
			}
		});
		// The first poll is now waiting on the lock, in the middle of a query
		await sleep(200);
		const stopping = worker.stop();
		let waited: boolean;
		try {
			waited = !(await settlesWithin(stopping, 300));
		} finally {
			await lock.release();
		}
		await stopping;
		expect(waited).toBe(true);
		expect(handled).toEqual([]);
		const rows = await h.db.sql<{ status: string }[]>`
			select status from jobs where dedup_key = 'shutdown:job'`;
		expect(rows[0]?.status).toBe('queued');
	});
});
