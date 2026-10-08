import type { Db, Tx } from '../db/client.js';
import { enqueueJob } from '../jobs/queue.js';

// Asks the matrix role to show the owner's assistant under its name: the job reads the name when it
// runs, so the last name set wins, and the jobs of one owner run one at a time. A job that failed
// for good gives way to the new one.
export async function requestNaming(db: Db | Tx, owner: string): Promise<void> {
	const key = `name:${owner}`;
	await db.sql`delete from jobs where group_key = ${key} and status = 'failed'`;
	await enqueueJob(db, { kind: 'name', payload: { owner }, groupKey: key });
}
