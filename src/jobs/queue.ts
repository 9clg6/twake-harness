import type { Db, Tx } from '../db/client.js';
import { readJsonColumn } from '../db/client.js';

export type JobKind = 'turn' | 'send' | 'recover' | 'resume' | 'progress' | 'prepare';

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
	// Jobs of one group run one at a time, in queue order, across every replica
	readonly groupKey?: string;
}

interface JobRow {
	id: number;
	kind: string;
	payload: unknown;
	attempts: number;
}

// Queued in the transaction given, a job goes out with what that transaction writes, or not at all
export async function enqueueJob(db: Db | Tx, input: EnqueueInput): Promise<boolean> {
	const payload = JSON.stringify(input.payload);
	const groupKey = input.groupKey ?? null;
	const result =
		input.dedupKey === undefined
			? await db.sql`
				insert into jobs (kind, payload, group_key) values (${input.kind}, ${payload}::jsonb, ${groupKey})`
			: await db.sql`
				insert into jobs (kind, payload, group_key, dedup_key)
				values (${input.kind}, ${payload}::jsonb, ${groupKey}, ${input.dedupKey})
				on conflict (dedup_key) do nothing`;
	return result.count === 1;
}

// Claims the oldest runnable job of the given kinds, skipping what other workers hold. A job
// whose group has an earlier job still queued or running waits for it, so a group keeps its
// order even when its jobs are spread over several replicas.
export async function claimJob(
	db: Db,
	kinds: readonly JobKind[],
	workerId: string
): Promise<Job | null> {
	const rows = await db.sql<JobRow[]>`
		update jobs set status = 'running', locked_by = ${workerId}, locked_at = now(), attempts = attempts + 1
		where id = (
			select j.id from jobs j
			where j.kind in ${db.sql([...kinds])} and j.status = 'queued' and j.run_after <= now()
				and not exists (
					select 1 from jobs p
					where p.group_key = j.group_key and p.id < j.id and p.status in ('queued', 'running'))
			order by j.id
			for update of j skip locked
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

// A job still running past its lease was held by a replica that is gone: it goes back to the
// queue for another one to take, as if the lost replica had never claimed it.
export async function requeueStaleJobs(db: Db, leaseMs: number): Promise<number> {
	const result = await db.sql`
		update jobs set status = 'queued', locked_by = null, locked_at = null
		where status = 'running' and locked_at < now() - make_interval(secs => ${leaseMs / 1000})`;
	return result.count;
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
