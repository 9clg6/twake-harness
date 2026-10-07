import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

import { withPrincipal, type Db } from '../db/client.js';
import { enqueueJob } from '../jobs/queue.js';
import { startJobWorker, type JobWorker } from '../jobs/worker.js';
import { fetchOwnerMessages } from '../assistants/locale.js';
import { findAssistant, type AssistantRecord } from '../assistants/repository.js';
import type { PendingQuestion, ResumeRequest } from '../consents/consent.js';
import { requestHtml } from '../consents/request.js';
import type { Locale, Messages } from '../i18n/messages.js';
import type { AgentService, OwnerTurnResult, TurnOrigin } from './service.js';

const turnPayload = z.object({
	owner: z.string().min(1),
	roomId: z.string().min(1),
	eventId: z.string().min(1),
	text: z.string().min(1),
	// Who started the turn: the owner's message, or an event a dispatcher posted
	origin: z.enum(['owner', 'event']).optional(),
	// The event a dispatcher posted, when the turn is an event's: its id and CloudEvent type, so
	// that the harness can read and check an invitation before the model speaks
	event: z.object({ id: z.string().min(1), type: z.string().min(1) }).optional()
});

export type TurnPayload = z.infer<typeof turnPayload>;

// The prefix that keys a turn an event woke, in its payload and its jobs' dedup keys
const EVENT_KEY_PREFIX = 'event:';

// What links a turn's contract calls and log lines to their cause: the Matrix id of the owner's
// message, or, for a turn an event woke, the bare id the dispatcher posted, which is also the
// event's row id and the dispatcher's own request and correlation ids, so that the gateway's
// audit records match it exactly. The prefixed form stays the turn's internal key.
function correlationIdOf(payload: TurnPayload, origin: TurnOrigin): string {
	if (origin !== 'event') return payload.eventId;
	if (payload.event !== undefined) return payload.event.id;
	return payload.eventId.startsWith(EVENT_KEY_PREFIX)
		? payload.eventId.slice(EVENT_KEY_PREFIX.length)
		: payload.eventId;
}

const resumePayload = z.object({
	owner: z.string().min(1),
	roomId: z.string().min(1),
	pendingCallId: z.string().min(1),
	// A job queued before answers came through the API was answered in the chat
	through: z.enum(['chat', 'api']).default('chat'),
	replyTo: z.string().min(1).optional()
}) satisfies z.ZodType<ResumeRequest>;

export interface SendPayload {
	readonly asUserId: string;
	readonly roomId: string;
	readonly text: string;
	// The message the text answers, which the matrix role marks as answered: the owner's own, or,
	// for a turn their reaction resumed, the assistant's question they reacted to
	readonly replyTo?: string;
	readonly outcome?: 'answered' | 'failed';
	// The text asks the owner about a frozen call: the matrix role remembers the event it sent,
	// which the owner's answer points to
	readonly request?: PendingQuestion;
	// The text as HTML, when the harness laid it out itself rather than the model writing Markdown
	readonly html?: string;
}

// The actions a turn has done so far, which the matrix role shows its owner in the turn's status
// message
export interface ProgressPayload {
	readonly asUserId: string;
	readonly roomId: string;
	// The message the turn answers, whose status shows them
	readonly replyTo: string;
	readonly actions: number;
}

// The counts of a turn's actions on their way to the queue
interface ActionReports {
	report(actions: number): void;
	// Resolves once every count reported is queued
	queued(): Promise<void>;
}

export interface TurnWorkerOptions {
	readonly db: Db;
	readonly agent: AgentService;
	readonly log: FastifyBaseLogger;
	// The language of the fixed texts a failed or refused turn answers with, for owners who chose
	// none
	readonly locale: Locale;
	readonly pollIntervalMs?: number;
	// How many turns this replica runs at once
	readonly concurrency?: number;
}

// Turns queued by the matrix role: the owner's message becomes an answer queued back for sending.
export function startTurnWorker(options: TurnWorkerOptions): JobWorker {
	const { db, agent, log, locale } = options;

	// The owner's assistant, when this room is still its room
	async function roomAssistant(owner: string, roomId: string): Promise<AssistantRecord | null> {
		const assistant = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
		if (assistant === null || assistant.deletedAt !== null) return null;
		const rooms = await db.sql`
			select 1 from assistant_rooms where room_id = ${roomId} and owner = ${owner}`;
		return rooms.length === 0 ? null : assistant;
	}

	// Each count goes to the matrix role in the room's order, best effort, so that the answer, queued
	// once they all are, comes after them
	function reportActions(
		log: FastifyBaseLogger,
		payload: Omit<ProgressPayload, 'actions'>
	): ActionReports {
		const queueing = new Set<Promise<void>>();
		return {
			report: (actions) => {
				const queued = enqueueJob(db, {
					kind: 'progress',
					payload: { ...payload, actions } satisfies ProgressPayload,
					groupKey: `send:${payload.roomId}`
				}).then(
					() => undefined,
					(err: unknown) => log.warn({ actions, err }, 'actions not reported')
				);
				queueing.add(queued);
				void queued.finally(() => queueing.delete(queued));
			},
			queued: async () => {
				await Promise.all([...queueing]);
			}
		};
	}

	// What the assistant sends back for a turn: its answer, or the fixed notice of a refused or
	// failed turn, and the question it asks when the turn froze a call
	function replyTo(
		result: OwnerTurnResult,
		assistant: AssistantRecord,
		roomId: string,
		notices: Messages['notices']
	): SendPayload {
		return {
			asUserId: assistant.userId,
			roomId,
			text:
				result.kind === 'ok'
					? result.answer
					: result.kind === 'busy'
						? notices.busy
						: notices.turnFailed,
			outcome: result.kind === 'ok' ? 'answered' : 'failed',
			...(result.kind === 'ok' && result.pendingCallId !== undefined
				? { request: { pendingCallId: result.pendingCallId, owner: assistant.owner } }
				: {}),
			// The harness's own request, laid out by the harness as HTML too
			...(result.kind === 'ok' && result.request !== undefined
				? { html: requestHtml(result.request) }
				: {})
		};
	}

	// Runs the call its owner allowed, then the rest of the turn, and sends the answer
	async function resume(request: ResumeRequest): Promise<void> {
		const { owner, roomId, pendingCallId, through } = request;
		const assistant = await roomAssistant(owner, roomId);
		if (assistant === null) {
			log.info({ owner, roomId }, 'resume dropped: no assistant for this room');
			return;
		}
		const turnLog = log.child({ reqId: `resume:${pendingCallId}`, roomId });
		const reports =
			request.replyTo === undefined
				? null
				: reportActions(turnLog, { asUserId: assistant.userId, roomId, replyTo: request.replyTo });
		const result = await agent.runOwnerTurn({
			principal: { id: owner },
			target: { kind: 'room', roomId },
			message: null,
			log: turnLog,
			assistantName: assistant.name,
			resume: { pendingCallId, through },
			...(reports === null ? {} : { actionsDone: reports.report })
		});
		await reports?.queued();
		// A call already decided, by an answer delivered twice for instance, runs nothing more
		if (result.kind === 'missing' || result.kind === 'decided') {
			turnLog.info({ pendingCallId }, 'resume dropped: the call is no longer waiting');
			return;
		}
		if (result.kind !== 'ok') turnLog.warn({ result }, 'resumed turn did not succeed');
		// Read once the turn is over: the owner may have changed their language in it
		const { notices } = await fetchOwnerMessages(db, owner, locale);
		await enqueueJob(db, {
			kind: 'send',
			payload: {
				...replyTo(result, assistant, roomId, notices),
				// What carries the owner's yes, which the matrix role marks as answered as it would a
				// message: their words, or the assistant's own question they reacted to
				...(request.replyTo === undefined ? {} : { replyTo: request.replyTo })
			},
			dedupKey: `send:resume:${pendingCallId}`,
			groupKey: `send:${roomId}`
		});
	}

	return startJobWorker({
		db,
		log,
		kinds: ['turn', 'resume'],
		...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
		...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
		handler: async (job) => {
			if (job.kind === 'resume') {
				const resumed = resumePayload.safeParse(job.payload);
				if (!resumed.success) throw new Error('resume payload is malformed');
				await resume(resumed.data);
				return;
			}
			const parsed = turnPayload.safeParse(job.payload);
			if (!parsed.success) throw new Error('turn payload is malformed');
			const { owner, roomId, eventId, text } = parsed.data;
			// A turn queued before the origin was recorded is an event's when its id says so
			const origin =
				parsed.data.origin ?? (eventId.startsWith(EVENT_KEY_PREFIX) ? 'event' : 'owner');
			const assistant = await roomAssistant(owner, roomId);
			if (assistant === null) {
				log.info({ owner, roomId }, 'turn dropped: no assistant for this room');
				return;
			}
			const correlationId = correlationIdOf(parsed.data, origin);
			const turnLog = log.child({ reqId: correlationId, roomId });
			// A turn woken by an event posted to the API answers no message of the room
			const reports = eventId.startsWith('$')
				? reportActions(turnLog, { asUserId: assistant.userId, roomId, replyTo: eventId })
				: null;
			const result = await agent.runOwnerTurn({
				principal: { id: owner },
				target: { kind: 'room', roomId },
				message: text,
				log: turnLog,
				correlationId,
				origin,
				assistantName: assistant.name,
				...(parsed.data.event === undefined ? {} : { event: parsed.data.event }),
				...(reports === null ? {} : { actionsDone: reports.report })
			});
			await reports?.queued();
			if (result.kind !== 'ok') turnLog.warn({ result }, 'turn did not succeed');
			// Read once the turn is over: the owner may have changed their language in it
			const { notices } = await fetchOwnerMessages(db, owner, locale);
			await enqueueJob(db, {
				kind: 'send',
				payload: {
					...replyTo(result, assistant, roomId, notices),
					// A turn woken by an event posted to the API answers no message of the room
					...(eventId.startsWith('$') ? { replyTo: eventId } : {})
				},
				dedupKey: `send:${eventId}`,
				groupKey: `send:${roomId}`
			});
		}
	});
}
