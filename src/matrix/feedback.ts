import type { FastifyBaseLogger } from 'fastify';

import type { Messages } from '../i18n/messages.js';

// How a turn ended: answered, answered once it reached its limit of tool calls, or failed or was
// refused, which alone earns no check mark
export type TurnOutcome = 'answered' | 'limited' | 'failed';

// The owner's message a turn answers, in the room of the assistant that answers it
export interface TurnRef {
	readonly assistantUserId: string;
	readonly roomId: string;
	readonly eventId: string;
}

// What a turn sends its owner, always as a message of its own so that they are notified of it: an
// answer, the notice of a failed or refused turn included, or a question about a call, which the
// owner then answers
export type TurnReply = 'answer' | 'question';

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
	// The texts of a turn's status message, in its owner's language as it is now
	statusTexts(turn: TurnRef): Promise<Messages['status']>;
	// How long a turn may go without an answer before its status message shows, and the least time
	// between two of its updates
	readonly statusDelayMs: number;
	readonly statusMaxMs?: number;
	readonly typingTimeoutMs?: number;
	readonly typingRefreshMs?: number;
	readonly typingMaxMs?: number;
}

// What the owner sees while the assistant works on a message, as Hermes showed it: eyes on the
// message and the assistant typing, then a check mark once the message is answered. A turn that
// takes a while also posts a status message, a reply to the message, which closes once the turn
// answered. All of it is best effort: a failure is logged and never holds a turn or an answer back.
export interface ChatFeedback {
	turnQueued(turn: TurnRef): Promise<void>;
	// The turn has done this many actions so far: its status shows them, at most one update per
	// delay
	turnProgressed(turn: TurnRef, actions: number): void;
	// Right before the reply goes out: the typing stops as it appears, and the status message the
	// owner sees, if any, stops counting. A question's status points to it before it goes out; any
	// other reply goes out after its status.
	answerReady(turn: TurnRef, reply: TurnReply): Promise<void>;
	// Once the reply went out: the eyes go, a check mark marks an answered message, and the status
	// closes on how the turn ended
	answerSent(turn: TurnRef, outcome: TurnOutcome): Promise<void>;
	// Lets what is already on its way (a check mark, a stopped typing) go out, within a bound. A
	// status still waiting for its answer gives up: the answer, once the role is back, goes out as a
	// message of its own.
	stop(): Promise<void>;
}

const WORKING = '👀';
const ANSWERED = '✅';
const DEFAULT_TYPING_TIMEOUT_MS = 30_000;
const DEFAULT_TYPING_REFRESH_MS = 20_000;
// A turn that died never answers: its room stops typing after this, whatever is still pending
const DEFAULT_TYPING_MAX_MS = 5 * 60_000;
// The eyes of a turn that never answered are forgotten after this
const ACK_TTL_MS = 60 * 60_000;
const STOP_GRACE_MS = 5_000;

// The words a status ends on: the turn answered, answered at its limit of tool calls, or failed or
// was refused, a question to its owner follows, or no answer came in time
type Closing = 'done' | 'limited' | 'notDone' | 'asking' | 'late';

const CLOSINGS: Readonly<Record<TurnOutcome, Closing>> = {
	answered: 'done',
	limited: 'limited',
	failed: 'notDone'
};

// The status message of a turn, from the delay before it shows to its last words
interface Status {
	readonly turn: TurnRef;
	readonly queuedAt: number;
	// The timer that posts the status once it is due, then the one that gives it up
	timer: NodeJS.Timeout | null;
	// Resolves to the status's event id once posted, or to null when it could not be; null until
	// it is due
	posted: Promise<string | null> | null;
	texts: Messages['status'] | null;
	// The status's events go out one after the other: clients show the last edit sent
	chain: Promise<unknown>;
	// The actions of the turn so far, those the status shows, and when it last changed
	actions: number;
	shown: number;
	shownAt: number;
	// The next update, once one is due
	update: NodeJS.Timeout | null;
	// The reply is on its way: the status no longer counts actions
	answering: boolean;
	// Closed for good, by its last words or as it could not be posted: nothing changes it any more
	closed: boolean;
}

function workingText(texts: Messages['status'], actions: number): string {
	return actions === 0 ? texts.working : texts.progress(actions);
}

interface Ack {
	// Resolves to the id of the eyes reaction, or null when it could not be sent
	readonly reaction: Promise<string | null>;
	readonly at: number;
}

function settleWithin(work: readonly Promise<unknown>[], ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		void Promise.allSettled(work).then(() => {
			clearTimeout(timer);
			resolve();
		});
	});
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
	// A turn that died never answers: its status gives up when its typing would stop
	const statusMaxMs = options.statusMaxMs ?? DEFAULT_TYPING_MAX_MS;
	// The matrix role runs as a single replica, so this memory is the only one. A restart between a
	// turn and its answer forgets the eyes: they stay on that message, next to the check mark.
	const acks = new Map<string, Ack>();
	const sessions = new Map<string, TypingSession>();
	// The typing calls of a room go out one after the other, so a late "typing" never lands after
	// the "stopped typing" sent before the answer
	const typingChains = new Map<string, Promise<void>>();
	// The status messages of the turns in the works, by the message they answer
	const statuses = new Map<string, Status>();
	// The calls on their way, which a stop lets finish while the homeserver and the store are up
	const inflight = new Set<Promise<unknown>>();
	function track(work: Promise<unknown>): void {
		inflight.add(work);
		void work.finally(() => inflight.delete(work)).catch(() => undefined);
	}

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
		track(next);
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

	// The status's work, after what is already on its way
	function inTurn<T>(status: Status, work: () => Promise<T>): Promise<T> {
		const next = status.chain.then(work);
		status.chain = next.catch(() => undefined);
		track(status.chain);
		return next;
	}

	function forget(status: Status): void {
		if (status.timer !== null) clearTimeout(status.timer);
		if (status.update !== null) clearTimeout(status.update);
		status.timer = null;
		status.update = null;
		if (statuses.get(status.turn.eventId) === status) statuses.delete(status.turn.eventId);
	}

	// An edit of the status: clients show its new words in the status's place
	async function replace(status: Status, eventId: string, body: string): Promise<void> {
		const { turn } = status;
		await options.sendEvent(turn.assistantUserId, turn.roomId, 'm.room.message', {
			msgtype: 'm.text',
			// What a client that shows no edits shows instead, by the convention of the spec
			body: `* ${body}`,
			'm.new_content': { msgtype: 'm.text', body },
			'm.relates_to': { rel_type: 'm.replace', event_id: eventId }
		});
	}

	// The status of the turn, due once the turn went without an answer for the delay
	function scheduleStatus(turn: TurnRef, now: number): void {
		if (statuses.has(turn.eventId)) return;
		const status: Status = {
			turn,
			queuedAt: now,
			timer: null,
			posted: null,
			texts: null,
			chain: Promise.resolve(),
			actions: 0,
			shown: 0,
			shownAt: 0,
			update: null,
			answering: false,
			closed: false
		};
		status.timer = setTimeout(() => postStatus(status), options.statusDelayMs);
		statuses.set(turn.eventId, status);
	}

	function postStatus(status: Status): void {
		const { turn } = status;
		const left = status.queuedAt + statusMaxMs - Date.now();
		// Due only past the bound: the turn has died, it gets no status
		if (left <= 0) {
			forget(status);
			return;
		}
		status.timer = setTimeout(() => void giveUp(status), left);
		status.posted = inTurn(status, async () => {
			try {
				const texts = await options.statusTexts(turn);
				status.texts = texts;
				const { actions } = status;
				const eventId = await options.sendEvent(
					turn.assistantUserId,
					turn.roomId,
					'm.room.message',
					{
						msgtype: 'm.text',
						body: workingText(texts, actions),
						// A reply, so the owner sees which of their messages it is about
						'm.relates_to': { 'm.in_reply_to': { event_id: turn.eventId } }
					}
				);
				status.shown = actions;
				status.shownAt = Date.now();
				log.info({ roomId: turn.roomId, eventId: turn.eventId }, 'status posted');
				return eventId;
			} catch (err: unknown) {
				// A status that never showed has nothing to update nor to close
				status.closed = true;
				forget(status);
				log.warn({ roomId: turn.roomId, eventId: turn.eventId, err }, 'status failed');
				return null;
			}
		});
		// Actions done while it went out show in its first update
		void status.posted.then(() => scheduleUpdate(status));
	}

	// The status shows the actions done so far, at most one update per delay, the latest count
	// winning
	function scheduleUpdate(status: Status): void {
		if (status.posted === null || status.update !== null) return;
		if (status.answering || status.closed || status.actions === status.shown) return;
		const wait = Math.max(0, status.shownAt + options.statusDelayMs - Date.now());
		status.update = setTimeout(() => {
			void inTurn(status, async () => {
				const eventId = await status.posted;
				const { texts, turn, actions } = status;
				if (eventId === null || texts === null || status.answering || status.closed) return;
				// Changed meanwhile, by its post: the next update waits its turn
				if (actions === status.shown || Date.now() < status.shownAt + options.statusDelayMs) {
					return;
				}
				status.shown = actions;
				status.shownAt = Date.now();
				try {
					await replace(status, eventId, texts.progress(actions));
				} catch (err: unknown) {
					log.warn({ roomId: turn.roomId, eventId: turn.eventId, err }, 'status update failed');
				}
			}).then(() => {
				status.update = null;
				scheduleUpdate(status);
			});
		}, wait);
	}

	// The status's last words: nothing changes it after them
	function closeWith(status: Status, closing: Closing): Promise<void> {
		forget(status);
		return inTurn(status, async () => {
			if (status.closed) return;
			status.closed = true;
			const eventId = await status.posted;
			if (eventId === null || status.texts === null) return;
			const { turn } = status;
			const words = status.texts[closing];
			// Last words are tried twice: a status left saying it works would be wrong for good
			for (let attempt = 1; attempt <= 2; attempt += 1) {
				try {
					await replace(status, eventId, words);
					log.info({ roomId: turn.roomId, eventId: turn.eventId, closing }, 'status closed');
					return;
				} catch (err: unknown) {
					log.warn(
						{ roomId: turn.roomId, eventId: turn.eventId, closing, attempt, err },
						'status update failed'
					);
				}
			}
		});
	}

	// No answer came in time, or the role stops: the status says so, and the answer, should it come,
	// goes out as a message of its own
	function giveUp(status: Status): Promise<void> {
		return closeWith(status, 'late');
	}

	return {
		turnProgressed: (turn, actions) => {
			const status = statuses.get(turn.eventId);
			if (status === undefined || status.answering || status.closed) return;
			status.actions = Math.max(status.actions, actions);
			scheduleUpdate(status);
		},
		turnQueued: async (turn) => {
			const now = Date.now();
			forgetOldAcks(now);
			// All are registered before anything is awaited: a fast answer finds them in place
			startTyping(turn);
			scheduleStatus(turn, now);
			const reaction = react(turn, WORKING);
			track(reaction);
			acks.set(turn.eventId, { reaction, at: now });
			await reaction;
		},
		answerReady: async (turn, reply) => {
			// Settled before anything is awaited: an answer ready before its status was due never shows
			// one, however long the typing takes to stop
			const status = statuses.get(turn.eventId);
			if (status?.posted === null) forget(status);
			const open = status !== undefined && status.posted !== null && !status.closed;
			if (open) {
				status.answering = true;
				if (status.update !== null) clearTimeout(status.update);
				status.update = null;
				// The reply now has the whole bound to go out: the status can no longer give up as it
				// does, only should the reply never go out
				if (status.timer !== null) clearTimeout(status.timer);
				status.timer = setTimeout(() => void giveUp(status), statusMaxMs);
			}
			const session = sessions.get(keyOf(turn));
			if (session !== undefined) {
				session.pending.delete(turn.eventId);
				// Another message of the owner may still be in the works: the assistant keeps typing for it
				if (session.pending.size === 0) await endTyping(turn);
			}
			if (!open) return;
			// A question's status points to it before it goes out; any other reply goes out after its
			// status and what the status already had on its way
			if (reply === 'question') await closeWith(status, 'asking');
			else await inTurn(status, () => Promise.resolve());
		},
		answerSent: (turn, outcome) => {
			// The reply went out on its own: its status, still open unless it pointed to a question,
			// closes on how the turn ended
			const status = statuses.get(turn.eventId);
			if (status !== undefined) void closeWith(status, CLOSINGS[outcome]);
			const work = (async (): Promise<void> => {
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
				if (outcome !== 'failed') await react(turn, ANSWERED);
			})();
			track(work);
			return work;
		},
		stop: async () => {
			for (const session of sessions.values()) {
				clearInterval(session.refresh);
				clearTimeout(session.deadline);
			}
			sessions.clear();
			for (const status of [...statuses.values()]) {
				if (status.posted === null) forget(status);
				else void giveUp(status);
			}
			await settleWithin([...inflight], STOP_GRACE_MS);
		}
	};
}
