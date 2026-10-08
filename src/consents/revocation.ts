import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

import type { Config } from '../config.js';
import type { Tx } from '../db/client.js';
import { enqueueJob } from '../jobs/queue.js';
import { fetchDelegation, revokeDelegation } from './broker.js';

// A revocation: the owner whose permission goes, and when they asked for their assistant's
// deletion
const revocationPayload = z.object({
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

// One try of a revocation, which revokes the owner's permission unless they gave it again since
// they asked for the deletion. The broker is asked first what it holds: a permission it dates after
// the deletion request stays, while one the owner gives between that question and the revocation
// that follows is revoked. One it no longer holds is revoked all the same: a try that failed may
// have erased it before the broker could leave the owner's Drive instance, which this try asks
// again. Throws, for the queue to try again, when the broker or its route fails.
async function revokeUnlessGivenAgain(
	config: Config,
	owner: string,
	requestedAt: Date
): Promise<'revoked' | 'kept'> {
	const held = await fetchDelegation(config, owner);
	if (held !== null && held.consentedAt.getTime() > requestedAt.getTime()) return 'kept';
	await revokeDelegation(config, owner);
	return 'revoked';
}

// Runs one try of the revocation a job carries, and says what it did
export async function runRevocation(
	config: Config,
	log: FastifyBaseLogger,
	payload: unknown
): Promise<void> {
	const parsed = revocationPayload.safeParse(payload);
	if (!parsed.success) throw new Error('revoke payload is malformed');
	const { owner, requestedAt } = parsed.data;
	const outcome = await revokeUnlessGivenAgain(config, owner, new Date(requestedAt));
	log.info(
		{ owner },
		outcome === 'revoked' ? 'delegation revoked' : 'delegation kept: given again since the deletion'
	);
}
