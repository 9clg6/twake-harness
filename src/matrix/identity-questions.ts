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
	recordIdentityAnswer
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
	// The owner wrote in the room: their yes or no answers the question about their identity when
	// they say it right after it, unless a request was asked in the room since, the newest question,
	// which takes it then. Words after the question close it to typed answers either way, but for
	// the words that raised it. Resolves to whether the message was an answer.
	wrote(room: RequestRoom, eventId: string, text: string): Promise<boolean>;
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
			if (written !== null && (await isIdentityAnswerEvent(tx, owner, eventId))) return 'again';
			const question = await closeIdentityQuestion(tx, owner, roomId, eventId);
			if (question === null || written === null) return null;
			// The owner answers the newest question of the room, as their client shows it
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
					eventId,
					lifetimeMs
				});
				if (asked === null) return null;
				await enqueueJob(tx, {
					kind: 'send',
					payload: {
						asUserId: assistantUserId,
						roomId,
						text: ownerDevices.identityQuestion,
						questionMarker: asked
					},
					dedupKey: `identity-question:${eventId}`,
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
