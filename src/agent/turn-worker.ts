import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

import { withPrincipal, type Db } from '../db/client.js';
import { enqueueJob } from '../jobs/queue.js';
import { startJobWorker, type JobWorker } from '../jobs/worker.js';
import { findAssistant } from '../assistants/repository.js';
import type { AgentService } from './service.js';

const turnPayload = z.object({
	owner: z.string().min(1),
	roomId: z.string().min(1),
	eventId: z.string().min(1),
	text: z.string().min(1)
});

export type TurnPayload = z.infer<typeof turnPayload>;

export interface SendPayload {
	readonly asUserId: string;
	readonly roomId: string;
	readonly text: string;
}

export interface TurnWorkerOptions {
	readonly db: Db;
	readonly agent: AgentService;
	readonly log: FastifyBaseLogger;
	readonly pollIntervalMs?: number;
}

const FAILURE_TEXT = 'Something went wrong on my side. Please try again in a moment.';

// Turns queued by the matrix role: the owner's message becomes an answer queued back for sending.
export function startTurnWorker(options: TurnWorkerOptions): JobWorker {
	const { db, agent, log } = options;
	return startJobWorker({
		db,
		log,
		kinds: ['turn'],
		...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
		handler: async (job) => {
			const parsed = turnPayload.safeParse(job.payload);
			if (!parsed.success) throw new Error('turn payload is malformed');
			const { owner, roomId, eventId, text } = parsed.data;
			const assistant = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
			if (assistant === null || assistant.deletedAt !== null || assistant.roomId !== roomId) {
				log.info({ owner, roomId }, 'turn dropped: no assistant for this room');
				return;
			}
			const turnLog = log.child({ reqId: eventId, roomId });
			const result = await agent.runOwnerTurn({
				principal: { id: owner },
				target: { kind: 'room', roomId },
				message: text,
				log: turnLog
			});
			const answer = result.kind === 'ok' ? result.answer : FAILURE_TEXT;
			if (result.kind !== 'ok') turnLog.warn({ result }, 'turn did not succeed');
			const payload: SendPayload = { asUserId: assistant.userId, roomId, text: answer };
			await enqueueJob(db, { kind: 'send', payload, dedupKey: `send:${eventId}` });
		}
	});
}
