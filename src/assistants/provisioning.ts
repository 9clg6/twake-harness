import { withPrincipal, type Db } from '../db/client.js';
import { enqueueJob } from '../jobs/queue.js';
import { findCrossSigning } from '../matrix/cross-signing-repository.js';

// What a provisioner hands the owner's client, which trusts the assistant's device once the
// identity the homeserver publishes for the assistant has this master key
export interface AssistantIdentity {
	readonly userId: string;
	readonly deviceId: string;
	readonly masterKey: string;
}

// The assistant's identity once its device is signed by it, as the matrix role recorded it; null
// while it is not
export async function readyIdentity(
	db: Db,
	owner: string,
	userId: string
): Promise<AssistantIdentity | null> {
	const record = await withPrincipal(db, { id: owner }, (tx) => findCrossSigning(tx, owner));
	if (record === null || record.deviceId === null) return null;
	return { userId, deviceId: record.deviceId, masterKey: record.masterPublicKey };
}

// Asks the matrix role to make the assistant's device and identity now, rather than when it first
// speaks: one request at a time per owner. One that failed for good keeps its key, which would
// refuse every later one: it goes, so that the owner's next call tries again.
export async function requestPreparation(db: Db, owner: string): Promise<boolean> {
	const key = `prepare:${owner}`;
	await db.sql`delete from jobs where dedup_key = ${key} and status = 'failed'`;
	return enqueueJob(db, { kind: 'prepare', payload: { owner }, dedupKey: key, groupKey: key });
}
