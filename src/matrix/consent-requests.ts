import type { FastifyBaseLogger } from 'fastify';

import { wordAnswer, type Answer, type AnswerKind } from '../consents/answers.js';
import type { ResumeRequest } from '../consents/consent.js';
import {
	closeRequestsToWords,
	decidePendingCall,
	findRequest,
	findRequestOpenToWords,
	isAnswerEvent,
	recordRequestEvent,
	type FoundRequest
} from '../consents/repository.js';
import { withPrincipal, type Db } from '../db/client.js';
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
	readonly messages: Messages;
	// Reacts to an event of the room as its assistant, encrypted when the room is
	react(room: RequestRoom, eventId: string, key: string): Promise<void>;
}

// The harness's requests in an assistant's room, and its owner's answers to them. The matrix role
// hands over only what it read encrypted from the owner's own device: nothing written in the
// owner's name on the server side, which cannot encrypt for the room, answers for them.
export interface ConsentRequests {
	// A request went out: the assistant puts its two buttons under it, as reactions that the
	// owner's tap repeats
	asked(room: RequestRoom, pendingCallId: string, eventId: string): Promise<void>;
	// The owner put one of the buttons, or a bare ✅ or ❌, on an event of the room
	reacted(
		room: RequestRoom,
		requestEventId: string,
		says: Answer,
		reactionEventId: string
	): Promise<void>;
	// The owner wrote in the room. An exact yes or no answers the room's request when it is their
	// next message after it, and starts no turn; anything else leaves the request to its buttons.
	// Resolves to whether the message was an answer.
	wrote(room: RequestRoom, eventId: string, text: string): Promise<boolean>;
}

export function makeConsentRequests(options: ConsentRequestsOptions): ConsentRequests {
	const { db, log, messages } = options;

	// A yes allows the call and a no refuses it; an answer to a request already decided, a second
	// tap for instance, changes nothing
	async function settle(
		room: RequestRoom,
		request: FoundRequest,
		answer: GivenAnswer
	): Promise<void> {
		const { roomId, owner } = room;
		const { pendingCallId, state } = request;
		if (state === 'open') {
			await decide(room, pendingCallId, answer);
			return;
		}
		log.info(
			{ roomId, owner, pendingCallId, answer: answer.says, via: answer.kind, state },
			'answer to a closed request'
		);
	}

	// A yes approves the call at once, so that no later answer undoes it, and queues the turn that
	// runs it with the owner's turns. A no refuses it, and the harness says so itself, without the
	// model.
	async function decide(
		room: RequestRoom,
		pendingCallId: string,
		answer: GivenAnswer
	): Promise<void> {
		const { roomId, owner } = room;
		if (answer.says === 'yes') {
			// Queued first: should the role stop before the approval, the same answer delivered
			// again finds the call still open, and its job queued once
			const resume: ResumeRequest = { owner, roomId, pendingCallId };
			await enqueueJob(db, {
				kind: 'resume',
				payload: resume,
				dedupKey: `resume:${pendingCallId}`,
				groupKey: `turn:${owner}`
			});
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
		if (answer.says === 'no' && decided) {
			await enqueueJob(db, {
				kind: 'send',
				payload: { asUserId: room.assistantUserId, roomId, text: messages.consent.refused },
				dedupKey: `refused:${pendingCallId}`,
				groupKey: `send:${roomId}`
			});
		}
	}

	return {
		asked: async (room, pendingCallId, eventId) => {
			const { roomId, owner } = room;
			const recorded = await withPrincipal(db, { id: owner }, (tx) =>
				recordRequestEvent(tx, pendingCallId, eventId, roomId)
			);
			if (!recorded) {
				log.warn({ roomId, pendingCallId }, 'question sent for a call that is no longer stored');
				return;
			}
			log.info({ roomId, pendingCallId }, 'question sent');
			// Best effort: should a button fail, the question is not asked again, and a bare ✅ or ❌,
			// or a word, still answers it
			try {
				await options.react(room, eventId, messages.consent.buttons.yes);
				await options.react(room, eventId, messages.consent.buttons.no);
			} catch (err: unknown) {
				log.warn({ roomId, pendingCallId, err }, 'question buttons failed');
			}
		},
		reacted: async (room, requestEventId, says, reactionEventId) => {
			const { owner } = room;
			const request = await withPrincipal(db, { id: owner }, (tx) =>
				findRequest(tx, owner, requestEventId)
			);
			if (request === null) return;
			await settle(room, request, { says, kind: 'reaction', eventId: reactionEventId });
		},
		wrote: async (room, eventId, text) => {
			const { roomId, owner } = room;
			const says = wordAnswer(text);
			const { answered, request } = await withPrincipal(db, { id: owner }, async (tx) => {
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
