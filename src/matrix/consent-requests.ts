import type { FastifyBaseLogger } from 'fastify';

import { wordAnswer, type Answer, type AnswerKind } from '../consents/answers.js';
import { lookUpAnswerable, refusalNoticeJob, resumeJob } from '../consents/answering.js';
import type { ConsentMetrics } from '../consents/metrics.js';
import {
	closeRequestsToWords,
	decidePendingCall,
	findRequest,
	findRequestOpenToWords,
	isAnswerEvent,
	recordAnswerEvent,
	recordRequestEvent,
	supersedeRequests,
	type FoundRequest
} from '../consents/repository.js';
import { withPrincipal, type Db, type Tx } from '../db/client.js';
import type { Messages } from '../i18n/messages.js';
import { enqueueJob } from '../jobs/queue.js';

// An assistant's room, where the harness asks its owner and the owner answers
export interface RequestRoom {
	readonly roomId: string;
	readonly owner: string;
	readonly assistantUserId: string;
}

// An answer as the owner gave it: what it says, how, and in which event
interface GivenAnswer {
	readonly says: Answer;
	readonly kind: AnswerKind;
	readonly eventId: string;
}

export interface ConsentRequestsOptions {
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	// The fixed texts an owner reads, in their language as it is now
	fetchMessages(owner: string): Promise<Messages>;
	// How long the owner may answer a request
	readonly lifetimeMs: number;
	// Where the matrix role counts the answers, and the requests closed unanswered
	readonly metrics: ConsentMetrics;
}

// The harness's requests in an assistant's room, and its owner's answers to them. The matrix role
// hands over only what it read encrypted from the owner's own device: nothing written in the
// owner's name on the server side, which cannot encrypt for the room, answers for them.
export interface ConsentRequests {
	// A request went out: it supersedes the one still open in the room. It carries no buttons: Twake
	// Chat sends the reactions a tap on one would repeat in the clear, which answer nothing.
	asked(room: RequestRoom, pendingCallId: string, eventId: string): Promise<void>;
	// The owner put a bare ✅ or ❌ on an event of the room
	reacted(
		room: RequestRoom,
		requestEventId: string,
		says: Answer,
		reactionEventId: string
	): Promise<void>;
	// The owner wrote in the room. An exact yes or no answers the room's request when it is their
	// next message after it, and starts no turn; anything else leaves the request to a reaction, or
	// to an answer through the API. Resolves to whether the message was an answer.
	wrote(room: RequestRoom, eventId: string, text: string): Promise<boolean>;
}

export function makeConsentRequests(options: ConsentRequestsOptions): ConsentRequests {
	const { db, log, fetchMessages, lifetimeMs, metrics } = options;

	const lookUp = <T>(owner: string, find: (tx: Tx) => Promise<T>): Promise<T> =>
		lookUpAnswerable({ db, log, metrics, lifetimeMs }, owner, find);

	// A yes allows the call and a no refuses it. An answer to a request that expired, or that a
	// newer one superseded, runs nothing, and the owner is told why, once: a second tap on it
	// changes nothing, as does one on a request already decided.
	async function settle(
		room: RequestRoom,
		request: FoundRequest,
		answer: GivenAnswer
	): Promise<void> {
		const { roomId, owner } = room;
		const { pendingCallId, state } = request;
		if (state === 'open') {
			await decide(room, request, answer);
			return;
		}
		log.info(
			{ roomId, owner, pendingCallId, answer: answer.says, via: answer.kind, state },
			'answer to a closed request'
		);
		if (state === 'decided') return;
		const first = await withPrincipal(db, { id: owner }, (tx) =>
			recordAnswerEvent(tx, owner, pendingCallId, answer.eventId)
		);
		if (!first) return;
		const messages = await fetchMessages(owner);
		await enqueueJob(db, {
			kind: 'send',
			payload: {
				asUserId: room.assistantUserId,
				roomId,
				text: state === 'expired' ? messages.consent.expired : messages.consent.superseded
			},
			dedupKey: `closed:${answer.eventId}`,
			groupKey: `send:${roomId}`
		});
		metrics.answered(request, answer.says, answer.kind, state);
	}

	// A yes approves the call at once, so that no later answer nor newer request undoes it, and
	// queues the turn that runs it with the owner's turns. A no refuses it, and the harness says so
	// itself, without the model.
	async function decide(
		room: RequestRoom,
		request: FoundRequest,
		answer: GivenAnswer
	): Promise<void> {
		const { roomId, owner } = room;
		const { pendingCallId } = request;
		if (answer.says === 'yes') {
			// Queued first: should the role stop before the approval, the same answer delivered
			// again finds the call still open, and its job queued once
			await enqueueJob(db, resumeJob({ owner, roomId, pendingCallId, through: 'chat' }));
		}
		const decided = await withPrincipal(db, { id: owner }, (tx) =>
			decidePendingCall(
				tx,
				owner,
				pendingCallId,
				answer.says === 'yes' ? 'approved' : 'refused',
				answer.eventId
			)
		);
		log.info(
			{ roomId, owner, pendingCallId, answer: answer.says, via: answer.kind, decided },
			'owner answered'
		);
		if (decided) metrics.answered(request, answer.says, answer.kind, 'decided');
		if (answer.says === 'no' && decided) {
			const messages = await fetchMessages(owner);
			await enqueueJob(
				db,
				refusalNoticeJob(room.assistantUserId, roomId, pendingCallId, messages.consent.refused)
			);
		}
	}

	return {
		asked: async (room, pendingCallId, eventId) => {
			const { roomId, owner } = room;
			const { recorded, superseded } = await withPrincipal(db, { id: owner }, async (tx) => {
				const stored = await recordRequestEvent(tx, pendingCallId, eventId, roomId);
				return {
					recorded: stored,
					superseded: stored ? await supersedeRequests(tx, owner, roomId, pendingCallId) : []
				};
			});
			for (const request of superseded) {
				log.info({ roomId, owner, pendingCallId: request.pendingCallId }, 'request superseded');
				metrics.superseded(request);
			}
			if (!recorded) {
				log.warn({ roomId, pendingCallId }, 'question sent for a call that is no longer stored');
				return;
			}
			log.info({ roomId, pendingCallId }, 'question sent');
		},
		reacted: async (room, requestEventId, says, reactionEventId) => {
			const { owner } = room;
			const request = await lookUp(owner, (tx) => findRequest(tx, owner, requestEventId));
			if (request === null) return;
			await settle(room, request, { says, kind: 'reaction', eventId: reactionEventId });
		},
		wrote: async (room, eventId, text) => {
			const { roomId, owner } = room;
			const says = wordAnswer(text);
			const { answered, request } = await lookUp(owner, async (tx) => {
				// Delivered again, the message that answered is still that answer
				const again = says !== null && (await isAnswerEvent(tx, owner, eventId));
				const found =
					says === null || again ? null : await findRequestOpenToWords(tx, owner, roomId);
				// Whatever it says, this message is the owner's next one after the room's request
				await closeRequestsToWords(tx, owner, roomId);
				return { answered: again, request: found };
			});
			if (answered) return true;
			if (says === null || request === null) return false;
			await settle(room, request, { says, kind: 'words', eventId });
			return true;
		}
	};
}
