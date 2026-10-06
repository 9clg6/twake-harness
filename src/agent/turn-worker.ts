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
	// The owner's message the text answers, which the matrix role marks as answered
	readonly replyTo?: string;
	readonly outcome?: 'answered' | 'failed';
}

export interface TurnWorkerOptions {
	readonly db: Db;
	readonly agent: AgentService;
	readonly log: FastifyBaseLogger;
	readonly pollIntervalMs?: number;
	// How many turns this replica runs at once
	readonly concurrency?: number;
}

const FAILURE_TEXT = 'Something went wrong on my side. Please try again in a moment.';
const BUSY_TEXT =
	'I am busy right now and cannot take this message. Please send it again in a moment.';

// Turns queued by the matrix role: the owner's message becomes an answer queued back for sending.
export function startTurnWorker(options: TurnWorkerOptions): JobWorker {
	const { db, agent, log } = options;
	return startJobWorker({
		db,
		log,
		kinds: ['turn'],
		...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
		...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
		handler: async (job) => {
			const parsed = turnPayload.safeParse(job.payload);
			if (!parsed.success) throw new Error('turn payload is malformed');
			const { owner, roomId, eventId, text } = parsed.data;
			const assistant = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
			const rooms =
				assistant === null || assistant.deletedAt !== null
					? []
					: await db.sql`select 1 from assistant_rooms where room_id = ${roomId} and owner = ${owner}`;
			if (assistant === null || rooms.length === 0) {
				log.info({ owner, roomId }, 'turn dropped: no assistant for this room');
				return;
			}
			const turnLog = log.child({ reqId: eventId, roomId });
			const result = await agent.runOwnerTurn({
				principal: { id: owner },
				target: { kind: 'room', roomId },
				message: text,
				log: turnLog,
				correlationId: eventId
			});
			const answer =
				result.kind === 'ok' ? result.answer : result.kind === 'busy' ? BUSY_TEXT : FAILURE_TEXT;
			if (result.kind !== 'ok') turnLog.warn({ result }, 'turn did not succeed');
			// A turn woken by an event posted to the API answers no message of the room
			const payload: SendPayload = {
				asUserId: assistant.userId,
				roomId,
				text: answer,
				...(eventId.startsWith('$') ? { replyTo: eventId } : {}),
				outcome: result.kind === 'ok' ? 'answered' : 'failed'
			};
			await enqueueJob(db, {
				kind: 'send',
				payload,
				dedupKey: `send:${eventId}`,
				groupKey: `send:${roomId}`
			});
		}
	});
}
