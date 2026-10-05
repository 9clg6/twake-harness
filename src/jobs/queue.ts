import type { Db } from '../db/client.js';
import { readJsonColumn } from '../db/client.js';

export type JobKind = 'turn' | 'send';

export interface Job {
	readonly id: number;
	readonly kind: JobKind;
	readonly payload: unknown;
	readonly attempts: number;
}

export interface EnqueueInput {
	readonly kind: JobKind;
	readonly payload: unknown;
	// Two enqueues with the same key keep one job: a redelivered event makes one turn
	readonly dedupKey?: string;
}

interface JobRow {
	id: number;
	kind: string;
	payload: unknown;
	attempts: number;
}

export async function enqueueJob(db: Db, input: EnqueueInput): Promise<boolean> {
	const payload = JSON.stringify(input.payload);
	const result =
		input.dedupKey === undefined
			? await db.sql`insert into jobs (kind, payload) values (${input.kind}, ${payload}::jsonb)`
			: await db.sql`
				insert into jobs (kind, payload, dedup_key) values (${input.kind}, ${payload}::jsonb, ${input.dedupKey})
				on conflict (dedup_key) do nothing`;
	return result.count === 1;
}

// Claims the oldest runnable job of the given kinds, skipping what other workers hold.
export async function claimJob(
	db: Db,
	kinds: readonly JobKind[],
	workerId: string
): Promise<Job | null> {
	const rows = await db.sql<JobRow[]>`
		update jobs set status = 'running', locked_by = ${workerId}, locked_at = now(), attempts = attempts + 1
		where id = (
			select id from jobs
			where kind in ${db.sql([...kinds])} and status = 'queued' and run_after <= now()
			order by id
			for update skip locked
			limit 1
		)
		returning id, kind, payload, attempts`;
	const row = rows[0];
	if (row === undefined) return null;
	return {
		id: Number(row.id),
		kind: row.kind as JobKind,
		payload: readJsonColumn(row.payload),
		attempts: Number(row.attempts)
	};
}

export async function completeJob(db: Db, id: number): Promise<void> {
	await db.sql`delete from jobs where id = ${id}`;
}

const MAX_ATTEMPTS = 3;

export async function failJob(db: Db, id: number, attempts: number, error: string): Promise<void> {
	if (attempts >= MAX_ATTEMPTS) {
		await db.sql`update jobs set status = 'failed', last_error = ${error}, finished_at = now() where id = ${id}`;
		return;
	}
	const delaySeconds = 2 ** attempts;
	await db.sql`
		update jobs set status = 'queued', locked_by = null, locked_at = null, last_error = ${error},
			run_after = now() + make_interval(secs => ${delaySeconds})
		where id = ${id}`;
}
