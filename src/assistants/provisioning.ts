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

// Where the assistant's identity stands, as the matrix role recorded it: ready once its device is
// signed by it; waiting for the owner's recovery after a lost store; not ready while being prepared
export type IdentityState =
	| { readonly state: 'ready'; readonly identity: AssistantIdentity }
	| { readonly state: 'awaiting_recovery' }
	| { readonly state: 'not_ready' };

export async function readIdentity(db: Db, owner: string, userId: string): Promise<IdentityState> {
	const record = await withPrincipal(db, { id: owner }, (tx) => findCrossSigning(tx, owner));
	// The record is the owner's, whichever assistant it was made for: one made for another
	// identifier, as before a change of the assistants' prefix, holds that assistant's keys, never
	// this one's, and a record from before identifiers were kept learns its own at the next
	// preparation. Either way this assistant is not ready yet.
	if (record === null || record.userId !== userId) return { state: 'not_ready' };
	if (record.awaitingRecovery) return { state: 'awaiting_recovery' };
	if (record.deviceId === null) return { state: 'not_ready' };
	return {
		state: 'ready',
		identity: { userId, deviceId: record.deviceId, masterKey: record.masterPublicKey }
	};
}

// Asks the matrix role to make the assistant's device and identity now, rather than when it first
// speaks: one job queued or running per owner, which the queue tries again until the identity is
// ready. A finished job is deleted, so the next call that finds the assistant unready asks anew; one
// that failed for good keeps its key, which would refuse every later one: it goes first.
export async function requestPreparation(db: Db, owner: string): Promise<boolean> {
	const key = `prepare:${owner}`;
	await db.sql`delete from jobs where dedup_key = ${key} and status = 'failed'`;
	return enqueueJob(db, { kind: 'prepare', payload: { owner }, dedupKey: key, groupKey: key });
}
