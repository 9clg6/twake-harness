import type { FastifyBaseLogger } from 'fastify';

import type { OwnerDeviceTrust } from '../config.js';
import { wordAnswer, type Answer } from '../consents/answers.js';
import { closeRequestsToWords, isRequestOpenToWordsSince } from '../consents/repository.js';
import { withPrincipal, type Db } from '../db/client.js';
import type { Messages } from '../i18n/messages.js';
import { enqueueJob } from '../jobs/queue.js';
import type { RequestRoom } from './consent-requests.js';
import {
	acceptSeenIdentity,
	askIdentityQuestion,
	closeIdentityQuestion,
	isIdentityAnswerEvent,
	recordIdentityAnswer,
	recordIdentityQuestionEvent
} from './owner-cross-signing-repository.js';

export interface IdentityQuestionsOptions {
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	// Only a deployment that reports asks: no message ever makes one that enforces hold an identity
	readonly mode: OwnerDeviceTrust;
	// The fixed texts an owner reads, in their language as it is now
	fetchMessages(owner: string): Promise<Messages>;
	// How long the question waits for the owner's answer
	readonly lifetimeMs: number;
}

// The question an assistant asks its owner, while the deployment only reports, once their words
// came from a session that another identity than the one held signed: whether they reset their
// identity themselves. Their yes holds that identity, as the API does; their no keeps the one held.
export interface IdentityQuestions {
	// Asks the owner in the room, in a question marked for their client: once per identity, and
	// again once the question expired unanswered
	ask(room: RequestRoom, eventId: string, masterPublicKey: string): Promise<void>;
	// The question went out in this event: from then on it is asked, the room's newest question
	// until another one reaches the room
	asked(room: RequestRoom, questionId: string, eventId: string): Promise<void>;
	// The owner wrote in the room: their yes or no answers the question about their identity when
	// they say it right after it, unless a request was asked in the room since, or asked there
	// again, the newest question, which takes it then. Words after the question close it to typed
	// answers either way, but for the words that raised it. Resolves to whether the message was an
	// answer.
	wrote(room: RequestRoom, eventId: string, text: string): Promise<boolean>;
}

// A question about a new identity that the harness sends an owner, as the job sending it names it
export interface PendingIdentityQuestion {
	readonly questionId: string;
	readonly owner: string;
}

export function isPendingIdentityQuestion(value: unknown): value is PendingIdentityQuestion {
	if (typeof value !== 'object' || value === null) return false;
	const question = value as Record<string, unknown>;
	return typeof question['questionId'] === 'string' && typeof question['owner'] === 'string';
}

// A yes or a no the owner wrote, with the texts that tell them what comes of it
interface WrittenAnswer {
	readonly says: Answer;
	readonly texts: Messages['ownerDevices'];
}

export function makeIdentityQuestions(options: IdentityQuestionsOptions): IdentityQuestions {
	const { db, log, mode, fetchMessages, lifetimeMs } = options;

	// The owner's yes or no to the question about their identity, once it is the newest question of
	// the room: a yes holds the identity it asks about, as the API does; a no keeps the one held.
	// Either way the assistant tells them what comes of it. Resolves to the answer taken, 'again'
	// for words that took it already, or null when the words answer nothing.
	async function answer(
		room: RequestRoom,
		eventId: string,
		written: WrittenAnswer | null
	): Promise<{ readonly questionId: string; readonly says: Answer } | 'again' | null> {
		const { roomId, owner, assistantUserId } = room;
		return withPrincipal(db, { id: owner }, async (tx) => {
			// Closed first, which takes the owner's row: of two deliveries of the same words at once,
			// the one that waited for the other finds the question closed, then the answer it took
			const question = await closeIdentityQuestion(tx, owner, roomId, eventId);
			if (written === null) return null;
			if (question === null) {
				// Delivered again, the message that answered is still that answer
				return (await isIdentityAnswerEvent(tx, owner, eventId)) ? 'again' : null;
			}
			// The owner answers the newest question of the room, as their client shows it: the one
			// asked there last, a request asked again counting from then
			if (await isRequestOpenToWordsSince(tx, owner, roomId, question.askedAt)) return null;
			const { says, texts } = written;
			await recordIdentityAnswer(tx, owner, question.id, says, eventId);
			await closeRequestsToWords(tx, owner, roomId);
			if (says === 'yes') {
				const { pinned } = await acceptSeenIdentity(tx, owner, question.masterPublicKey, 'chat');
				if (pinned === null) throw new Error('the identity asked about is no longer the one seen');
			}
			await enqueueJob(tx, {
				kind: 'send',
				payload: {
					asUserId: assistantUserId,
					roomId,
					text: says === 'yes' ? texts.identityAdopted : texts.identityRejected
				},
				dedupKey: `identity-answer:${eventId}`,
				groupKey: `send:${roomId}`
			});
			return { questionId: question.id, says };
		});
	}

	return {
		ask: async (room, eventId, masterPublicKey) => {
			const { roomId, owner, assistantUserId } = room;
			// Read before the transaction, which holds the owner's row until it ends
			const { ownerDevices } = await fetchMessages(owner);
			const question = await withPrincipal(db, { id: owner }, async (tx) => {
				const asked = await askIdentityQuestion(tx, owner, {
					masterPublicKey,
					roomId,
					raisedBy: eventId,
					lifetimeMs
				});
				if (asked === null) return null;
				const pending: PendingIdentityQuestion = { questionId: asked.id, owner };
				await enqueueJob(tx, {
					kind: 'send',
					payload: {
						asUserId: assistantUserId,
						roomId,
						text: ownerDevices.identityQuestion,
						questionMarker: asked,
						identityQuestion: pending
					},
					dedupKey: `identity-question:${asked.id}`,
					groupKey: `send:${roomId}`
				});
				return asked;
			});
			if (question !== null) {
				log.info(
					{ roomId, owner, eventId, mode, questionId: question.id },
					'owner asked about their identity'
				);
			}
		},
		asked: async (room, questionId, eventId) => {
			const { roomId, owner } = room;
			const recorded = await withPrincipal(db, { id: owner }, (tx) =>
				recordIdentityQuestionEvent(tx, owner, questionId, eventId)
			);
			if (!recorded) {
				log.warn({ roomId, owner, questionId }, 'identity question sent once another replaced it');
				return;
			}
			log.info({ roomId, owner, questionId }, 'identity question sent');
		},
		wrote: async (room, eventId, text) => {
			if (mode !== 'report') return false;
			const { roomId, owner } = room;
			const says = wordAnswer(text);
			let taken: Awaited<ReturnType<typeof answer>>;
			try {
				// Read before the transaction, which holds the owner's row until it ends, and only for
				// words that may answer
				const written =
					says === null ? null : { says, texts: (await fetchMessages(owner)).ownerDevices };
				taken = await answer(room, eventId, written);
			} catch (err: unknown) {
				// The owner's words count all the same, for a request or a turn
				log.error({ roomId, owner, eventId, mode, err }, 'owner identity answer failed');
				return false;
			}
			if (taken === null) return false;
			if (taken !== 'again') {
				log.info({ roomId, owner, eventId, ...taken }, 'owner answered the identity question');
			}
			return true;
		}
	};
}
