import type { Db, Tx } from '../db/client.js';
import { enqueueJob } from '../jobs/queue.js';

// Asks the matrix role to show the owner's assistant under its name: the job reads the name when it
// runs, so the last name set wins, and the jobs of one owner run one at a time. A job that failed
// for good gives way to the new one. After its owner, an assistant still under a former default
// name takes its owner's first name first.
export async function requestNaming(
	db: Db | Tx,
	owner: string,
	options: { readonly afterOwner?: boolean } = {}
): Promise<void> {
	const key = `name:${owner}`;
	await db.sql`delete from jobs where group_key = ${key} and status = 'failed'`;
	const payload = options.afterOwner === true ? { owner, afterOwner: true } : { owner };
	await enqueueJob(db, { kind: 'name', payload, groupKey: key });
}
