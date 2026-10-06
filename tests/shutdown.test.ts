import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeDb, type Db } from '../src/db/client.js';
import { enqueueJob } from '../src/jobs/queue.js';
import { startJobWorker } from '../src/jobs/worker.js';
import { startTestHarness, TEST_DATABASE_URL, type TestHarness } from './helpers/app.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HeldLock {
	release(): Promise<void>;
}

// Holds an exclusive lock on a table from another connection, so that background work reaching
// that table waits in the middle of a query: the window a shutdown must not leave behind
async function lockTable(table: 'jobs' | 'assistant_rooms'): Promise<HeldLock> {
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

describe('stopping the matrix role', () => {
	let h: MatrixTestHarness;
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};
	beforeAll(async () => {
		h = await startMatrixHarness();
		process.on('unhandledRejection', onUnhandled);
	}, 180_000);
	afterAll(async () => {
		process.off('unhandledRejection', onUnhandled);
		if (h !== undefined) await h.close();
	});

	// Pushes one join the way Synapse does, and returns the status the role answered
	async function push(transactionId: string, eventId: string): Promise<number> {
		const response = await fetch(
			`http://127.0.0.1:${h.port}/_matrix/app/v1/transactions/${transactionId}`,
			{
				method: 'PUT',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${h.hsToken}` },
				body: JSON.stringify({
					events: [
						{
							type: 'm.room.member',
							sender: '@shutdown:test.local',
							state_key: '@shutdown:test.local',
							room_id: '!shutdown:test.local',
							event_id: eventId,
							origin_server_ts: Date.now(),
							content: { membership: 'join' }
						}
					]
				})
			}
		);
		await response.arrayBuffer();
		return response.status;
	}

	it('refuses new pushes, waits for the handlers of the accepted ones, and leaves no query behind', async () => {
		const lock = await lockTable('assistant_rooms');
		// A join Synapse pushed just before the shutdown, as when an owner enters a fresh assistant
		// room: its handler looks the room up for a greeting to send, and waits on the lock
		expect(await push('shutdown-1', '$shutdown-1')).toBe(200);
		await sleep(200);
		const stopping = h.role.stop();
		let waited: boolean;
		let refused: number;
		try {
			waited = !(await settlesWithin(stopping, 300));
			// Synapse keeps its connection alive and goes on pushing during a stop: such a push is
			// refused, so that Synapse delivers it again later, and nothing of it is processed
			refused = await push('shutdown-2', '$shutdown-2');
		} finally {
			await lock.release();
		}
		await stopping;
		expect(waited).toBe(true);
		expect(refused).toBe(503);
		const recorded = await h.db.sql<{ id: string }[]>`
			select id from matrix_transactions where id in ('shutdown-1', 'shutdown-2') order by id`;
		expect(recorded.map((row) => row.id)).toEqual(['shutdown-1']);
		// Whatever the handler still had to do happened before the stop returned
		await sleep(500);
		expect(unhandled).toEqual([]);
	});
});
