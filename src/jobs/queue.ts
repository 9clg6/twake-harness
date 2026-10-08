import type { Db, Tx } from '../db/client.js';
import { readJsonColumn } from '../db/client.js';

export type JobKind =
	'turn' | 'send' | 'recover' | 'resume' | 'progress' | 'prepare' | 'name' | 'revoke';

export interface Job {
	readonly id: number;
	readonly kind: JobKind;
	readonly payload: unknown;
	readonly attempts: number;
	// How many times its handler deferred it so far
	readonly deferrals: number;
	// How long ago its handler first deferred it, by the database's clock when it was claimed: 0
	// for a job never deferred
	readonly deferredForMs: number;
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
	deferrals: number;
	deferred_for_ms: string;
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

// Queued even when a job of the same key failed for good: that job no longer holds the key, and
// the new one takes its row, as if newly queued, under a fresh id that puts it at the back of the
// queue. A job of the key still queued, running or deferred keeps it, and nothing is queued.
export async function enqueueJobReplacingFailed(
	db: Db | Tx,
	input: EnqueueInput & { readonly dedupKey: string }
): Promise<boolean> {
	const payload = JSON.stringify(input.payload);
	const groupKey = input.groupKey ?? null;
	const result = await db.sql`
		insert into jobs (kind, payload, group_key, dedup_key)
		values (${input.kind}, ${payload}::jsonb, ${groupKey}, ${input.dedupKey})
		on conflict (dedup_key) do update set
			id = nextval(pg_get_serial_sequence('jobs', 'id')), kind = excluded.kind,
			payload = excluded.payload, group_key = excluded.group_key, status = 'queued', attempts = 0,
			deferrals = 0, first_deferred_at = null, run_after = now(), locked_by = null,
			locked_at = null, last_error = null, created_at = now(), finished_at = null
		where jobs.status = 'failed'`;
	return result.count === 1;
}

// Queued at the back of its group, whose jobs that failed for good are dropped: the new one does
// their work over again. No key keeps it out, so one queued while a job of its group runs still
// runs after it, and sees what changed meanwhile.
export async function enqueueJobDroppingFailed(
	db: Db | Tx,
	input: Omit<EnqueueInput, 'dedupKey'> & { readonly groupKey: string }
): Promise<boolean> {
	await db.sql`delete from jobs where group_key = ${input.groupKey} and status = 'failed'`;
	return enqueueJob(db, input);
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
		returning id, kind, payload, attempts, deferrals,
			coalesce((extract(epoch from now() - first_deferred_at) * 1000)::bigint, 0)
				as deferred_for_ms`;
	const row = rows[0];
	if (row === undefined) return null;
	return {
		id: Number(row.id),
		kind: row.kind as JobKind,
		payload: readJsonColumn(row.payload),
		attempts: Number(row.attempts),
		deferrals: Number(row.deferrals),
		deferredForMs: Number(row.deferred_for_ms)
	};
}

// A job its handler could not run yet waits out of its group's way until it is due, holding back
// none of the jobs queued behind it. Its claim counts as no attempt, which only a failure is.
export async function deferJob(db: Db, id: number, delayMs: number): Promise<void> {
	await db.sql`
		update jobs set status = 'deferred', locked_by = null, locked_at = null,
			attempts = attempts - 1, deferrals = deferrals + 1,
			first_deferred_at = coalesce(first_deferred_at, now()),
			run_after = now() + make_interval(secs => ${delayMs / 1000})
		where id = ${id}`;
}

// The deferred jobs that are due come back at the end of their group, as if queued now: a job of
// the group queued while they waited, which may be running already, keeps its place ahead of them,
// so that the group still runs one job at a time
export async function requeueDeferredJobs(db: Db, kinds: readonly JobKind[]): Promise<void> {
	await db.sql`
		update jobs set status = 'queued', id = nextval(pg_get_serial_sequence('jobs', 'id'))
		where kind in ${db.sql([...kinds])} and status = 'deferred' and run_after <= now()`;
}

// A job still running past its lease was held by a replica that is gone: it goes back to the
// queue for another one to take, as if the lost replica had never claimed it.
export async function requeueStaleJobs(db: Db, leaseMs: number): Promise<number> {
	const result = await db.sql`
		update jobs set status = 'queued', locked_by = null, locked_at = null
		where status = 'running' and locked_at < now() - make_interval(secs => ${leaseMs / 1000})`;
	return result.count;
}

// The jobs an assistant's erasure takes with it, by the payload field that names it: its owner's
// turns, an event's included, whatever their state, which then keep nothing; its owner's namings,
// so that none shows the deleted assistant's name again; the recoveries and preparations of its
// owner that failed for good, which no route shows; and what it was to send, answers and status
// counts. A kind these lists do not name stays, as one a later build adds: so do the revocations
// of the owner's permission at the broker, the one this erasure queues after them included.
const OWNER_JOBS: readonly JobKind[] = ['turn', 'resume', 'name'];
const OWNER_JOBS_FAILED: readonly JobKind[] = ['recover', 'prepare'];
const ASSISTANT_JOBS: readonly JobKind[] = ['send', 'progress'];

// Deletes the jobs of the owner's assistant, the account it speaks as, in the transaction given
export async function deleteJobsOf(tx: Tx, owner: string, userId: string): Promise<void> {
	// A payload is kept as the JSON text of its fields
	const field = (key: string) => tx.sql`(payload #>> '{}')::jsonb ->> ${key}`;
	await tx.sql`
		delete from jobs where
			(
				(kind in ${tx.sql(OWNER_JOBS)} or (kind in ${tx.sql(OWNER_JOBS_FAILED)} and status = 'failed'))
				and ${field('owner')} = ${owner}
			)
			or (kind in ${tx.sql(ASSISTANT_JOBS)} and ${field('asUserId')} = ${userId})`;
}

// A job done is deleted, its dedup key free again: within a transaction, a handler can finish its
// job with what it wrote, before its worker does
export async function completeJob(db: Db | Tx, id: number): Promise<void> {
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
