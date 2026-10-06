import type { FastifyBaseLogger } from 'fastify';

// How a turn ended, as the send job tells it: only an answered message earns the check mark
export type TurnOutcome = 'answered' | 'failed';

// The owner's message a turn answers, in the room of the assistant that answers it
export interface TurnRef {
	readonly assistantUserId: string;
	readonly roomId: string;
	readonly eventId: string;
}

export interface ChatFeedbackOptions {
	readonly log: FastifyBaseLogger;
	setTyping(userId: string, roomId: string, typing: boolean, timeoutMs: number): Promise<void>;
	// Sends a room event as the user, encrypted when the room is; resolves to its event id
	sendEvent(
		userId: string,
		roomId: string,
		type: string,
		content: Record<string, unknown>
	): Promise<string>;
	redactEvent(userId: string, roomId: string, eventId: string): Promise<void>;
	readonly typingTimeoutMs?: number;
	readonly typingRefreshMs?: number;
	readonly typingMaxMs?: number;
}

// What the owner sees while the assistant works on a message, as Hermes showed it: eyes on the
// message and the assistant typing, then a check mark once the message is answered. All of it is
// best effort: a failure is logged and never holds a turn or an answer back.
export interface ChatFeedback {
	turnQueued(turn: TurnRef): Promise<void>;
	// Right before the answer goes out, so the typing stops as the answer appears
	answerReady(turn: TurnRef): Promise<void>;
	answerSent(turn: TurnRef, outcome: TurnOutcome): Promise<void>;
	stop(): void;
}

const WORKING = '👀';
const ANSWERED = '✅';
const DEFAULT_TYPING_TIMEOUT_MS = 30_000;
const DEFAULT_TYPING_REFRESH_MS = 20_000;
// A turn that died never answers: its room stops typing after this, whatever is still pending
const DEFAULT_TYPING_MAX_MS = 5 * 60_000;
// The eyes of a turn that never answered are forgotten after this
const ACK_TTL_MS = 60 * 60_000;

interface Ack {
	// Resolves to the id of the eyes reaction, or null when it could not be sent
	readonly reaction: Promise<string | null>;
	readonly at: number;
}

interface TypingSession {
	readonly pending: Set<string>;
	readonly refresh: NodeJS.Timeout;
	deadline: NodeJS.Timeout;
}

export function makeChatFeedback(options: ChatFeedbackOptions): ChatFeedback {
	const { log } = options;
	const typingTimeoutMs = options.typingTimeoutMs ?? DEFAULT_TYPING_TIMEOUT_MS;
	const typingRefreshMs = options.typingRefreshMs ?? DEFAULT_TYPING_REFRESH_MS;
	const typingMaxMs = options.typingMaxMs ?? DEFAULT_TYPING_MAX_MS;
	// The matrix role runs as a single replica, so this memory is the only one. A restart between a
	// turn and its answer forgets the eyes: they stay on that message, next to the check mark.
	const acks = new Map<string, Ack>();
	const sessions = new Map<string, TypingSession>();
	// The typing calls of a room go out one after the other, so a late "typing" never lands after
	// the "stopped typing" sent before the answer
	const typingChains = new Map<string, Promise<void>>();

	function keyOf(turn: TurnRef): string {
		return `${turn.assistantUserId} ${turn.roomId}`;
	}

	function queueTyping(turn: TurnRef, typing: boolean): Promise<void> {
		const key = keyOf(turn);
		const next = (typingChains.get(key) ?? Promise.resolve())
			.then(() => options.setTyping(turn.assistantUserId, turn.roomId, typing, typingTimeoutMs))
			.catch((err: unknown) => {
				log.warn({ roomId: turn.roomId, typing, err }, 'typing notice failed');
			});
		typingChains.set(key, next);
		return next;
	}

	function endTyping(turn: TurnRef): Promise<void> {
		const key = keyOf(turn);
		const session = sessions.get(key);
		if (session === undefined) return Promise.resolve();
		clearInterval(session.refresh);
		clearTimeout(session.deadline);
		sessions.delete(key);
		return queueTyping(turn, false);
	}

	function startTyping(turn: TurnRef): void {
		const key = keyOf(turn);
		const existing = sessions.get(key);
		if (existing !== undefined) {
			existing.pending.add(turn.eventId);
			clearTimeout(existing.deadline);
			existing.deadline = setTimeout(() => void endTyping(turn), typingMaxMs);
			return;
		}
		sessions.set(key, {
			pending: new Set([turn.eventId]),
			refresh: setInterval(() => void queueTyping(turn, true), typingRefreshMs),
			deadline: setTimeout(() => void endTyping(turn), typingMaxMs)
		});
		void queueTyping(turn, true);
	}

	async function react(turn: TurnRef, key: string): Promise<string | null> {
		try {
			return await options.sendEvent(turn.assistantUserId, turn.roomId, 'm.reaction', {
				'm.relates_to': { rel_type: 'm.annotation', event_id: turn.eventId, key }
			});
		} catch (err: unknown) {
			log.warn({ roomId: turn.roomId, eventId: turn.eventId, key, err }, 'reaction failed');
			return null;
		}
	}

	function forgetOldAcks(now: number): void {
		for (const [eventId, ack] of acks) {
			if (now - ack.at > ACK_TTL_MS) acks.delete(eventId);
		}
	}

	return {
		turnQueued: async (turn) => {
			const now = Date.now();
			forgetOldAcks(now);
			// Both are registered before anything is awaited: a fast answer finds them in place
			startTyping(turn);
			const reaction = react(turn, WORKING);
			acks.set(turn.eventId, { reaction, at: now });
			await reaction;
		},
		answerReady: async (turn) => {
			const session = sessions.get(keyOf(turn));
			if (session === undefined) return;
			session.pending.delete(turn.eventId);
			// Another message of the owner may still be in the works: the assistant keeps typing for it
			if (session.pending.size === 0) await endTyping(turn);
		},
		answerSent: async (turn, outcome) => {
			const ack = acks.get(turn.eventId);
			acks.delete(turn.eventId);
			const eyes = ack === undefined ? null : await ack.reaction;
			if (eyes !== null) {
				try {
					await options.redactEvent(turn.assistantUserId, turn.roomId, eyes);
				} catch (err: unknown) {
					log.warn(
						{ roomId: turn.roomId, eventId: turn.eventId, err },
						'reaction redaction failed'
					);
				}
			}
			if (outcome === 'answered') await react(turn, ANSWERED);
		},
		stop: () => {
			for (const session of sessions.values()) {
				clearInterval(session.refresh);
				clearTimeout(session.deadline);
			}
			sessions.clear();
		}
	};
}
