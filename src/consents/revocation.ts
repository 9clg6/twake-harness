import { z } from 'zod';

import type { Config } from '../config.js';
import type { Tx } from '../db/client.js';
import { enqueueJob } from '../jobs/queue.js';
import { fetchDelegation, revokeDelegation } from './broker.js';

// A revocation: the owner whose permission goes, and when they asked for their assistant's
// deletion
export const revocationPayload = z.object({
	owner: z.string().min(1),
	requestedAt: z.iso.datetime({ offset: true })
});

// Queues, in the transaction that erases the owner's assistant, the revocation of their permission
// for it to act for them, as the broker holds it: a job of its own, which the deletion never waits
// for, which the queue tries again when the broker or its route fails, then gives up, as any job,
// and which no erasure of the owner's jobs takes. The revocations of one owner run one at a time,
// in the order of their deletions.
export async function requestRevocation(tx: Tx, owner: string, requestedAt: Date): Promise<void> {
	await enqueueJob(tx, {
		kind: 'revoke',
		payload: { owner, requestedAt: requestedAt.toISOString() },
		groupKey: `revoke:${owner}`
	});
}

// Whether a try revoked the owner's permission, or kept the one they gave again since they asked
// for the deletion
export type RevocationOutcome = 'revoked' | 'kept';

// One try of a revocation. The broker is asked first what it holds, so that a permission it dates
// after the deletion was asked for, which the owner gave again, between two tries for instance,
// stays. One it no longer holds is revoked all the same: a try that failed may have erased it
// before the broker could leave the owner's Drive instance, which this try asks again. Throws, for
// the queue to try again, when the broker or its route fails.
export async function revokeOwnerDelegation(
	config: Config,
	owner: string,
	requestedAt: Date
): Promise<RevocationOutcome> {
	const held = await fetchDelegation(config, owner);
	if (held !== null && held.consentedAt.getTime() > requestedAt.getTime()) return 'kept';
	await revokeDelegation(config, owner);
	return 'revoked';
}
