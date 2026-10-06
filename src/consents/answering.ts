import type { FastifyBaseLogger } from 'fastify';

import { withPrincipal, type Db, type Tx } from '../db/client.js';
import type { EnqueueInput } from '../jobs/queue.js';
import type { ResumeRequest } from './consent.js';
import type { ConsentMetrics } from './metrics.js';
import { expireRequests } from './repository.js';

// What an owner's answer sets going, whether they answered in the room or through the API. The
// dedup keys make one answer run its call once and say a refusal once, whichever path took it, so
// both paths take their jobs from here.

// The turn that runs a call its owner allowed, queued with the owner's other turns
export function resumeJob(request: ResumeRequest): EnqueueInput {
	return {
		kind: 'resume',
		payload: request,
		dedupKey: `resume:${request.pendingCallId}`,
		groupKey: `turn:${request.owner}`
	};
}

// What the assistant says in the room once its owner refused a call asked there
export function refusalNoticeJob(
	assistantUserId: string,
	roomId: string,
	pendingCallId: string,
	text: string
): EnqueueInput {
	return {
		kind: 'send',
		payload: { asUserId: assistantUserId, roomId, text },
		dedupKey: `refused:${pendingCallId}`,
		groupKey: `send:${roomId}`
	};
}

export interface AnswerLookup {
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	// Where the role counts the requests it finds past their lifetime
	readonly metrics: ConsentMetrics;
	// How long the owner may answer a request
	readonly lifetimeMs: number;
}

// Looks an owner's requests up once those left unanswered past their lifetime expired, so that a
// late answer finds its request expired even between two passes of the worker role
export async function lookUpAnswerable<T>(
	lookup: AnswerLookup,
	owner: string,
	find: (tx: Tx) => Promise<T>
): Promise<T> {
	const { db, log, metrics, lifetimeMs } = lookup;
	const { expired, found } = await withPrincipal(db, { id: owner }, async (tx) => ({
		expired: await expireRequests(tx, owner, lifetimeMs),
		found: await find(tx)
	}));
	for (const request of expired) {
		log.info({ owner, pendingCallId: request.pendingCallId }, 'request expired');
		metrics.expired(request);
	}
	return found;
}
