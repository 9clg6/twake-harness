import type { FastifyBaseLogger } from 'fastify';

import type { Messages } from '../i18n/messages.js';
import type { RichText } from './format.js';

// How a turn ended, as the send job tells it: only an answered message earns the check mark
export type TurnOutcome = 'answered' | 'failed';

// The owner's message a turn answers, in the room of the assistant that answers it
export interface TurnRef {
	readonly assistantUserId: string;
	readonly roomId: string;
	readonly eventId: string;
}

// What a turn sends its owner. An answer, and a question about a call, which the owner then answers,
// go out as messages of their own, so that the owner is notified of them; the notice of a failed or
// refused turn takes the place of the status message they saw while it worked.
export type TurnReply =
	| { readonly kind: 'answer' }
	| { readonly kind: 'question' }
	| { readonly kind: 'notice'; readonly content: RichText };

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
// answered. All of it is best effort: a failure is logged and never holds a turn or an answer
// back, a failed turn's notice aside, which goes out in the status's place and fails as a message
// would.
export interface ChatFeedback {
	turnQueued(turn: TurnRef): Promise<void>;
	// The turn has done this many actions so far: its status shows them, at most one update per
	// delay
	turnProgressed(turn: TurnRef, actions: number): void;
	// Right before the reply goes out: the typing stops as it appears, and the status message the
	// owner sees, if any, stops counting. A question's status points to it; a notice takes the
	// status's place. Resolves to the status's event id once the notice replaced it, or to null when
	// the reply is to go out as a message of its own. A replacement that fails throws, the status
	// staying for the next attempt.
	answerReady(turn: TurnRef, reply: TurnReply): Promise<string | null>;
	// Once the reply went out: the eyes go, a check mark marks an answered message, and the status
	// of an answer says it is done
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
// What a client that shows no edits shows of one, by the convention of the spec: the new text
// marked as an edit, cut short, the new content carrying it whole
const EDIT_FALLBACK_MAX_CHARS = 1_000;

// What a status message shows: the harness's own words, or a notice as it would have gone out
interface StatusContent {
	readonly msgtype: 'm.text';
	readonly body: string;
	readonly format?: string;
	readonly formatted_body?: string;
}

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
	// The answer is on its way: the status no longer counts actions
	answering: boolean;
	// Closed for good, by its last words or a failed turn's notice: nothing changes it any more
	closed: boolean;
}

function workingText(texts: Messages['status'], actions: number): string {
	return actions === 0 ? texts.working : texts.progress(actions);
}

function editFallback(body: string): string {
	const characters = Array.from(body);
	return characters.length <= EDIT_FALLBACK_MAX_CHARS
		? `* ${body}`
		: `* ${characters.slice(0, EDIT_FALLBACK_MAX_CHARS).join('')}…`;
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

	// An edit of the status: clients show its new content in the status's place
	async function replace(status: Status, eventId: string, content: StatusContent): Promise<void> {
		const { turn } = status;
		await options.sendEvent(turn.assistantUserId, turn.roomId, 'm.room.message', {
			msgtype: 'm.text',
			body: editFallback(content.body),
			'm.new_content': content,
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
					await replace(status, eventId, { msgtype: 'm.text', body: texts.progress(actions) });
				} catch (err: unknown) {
					log.warn({ roomId: turn.roomId, eventId: turn.eventId, err }, 'status update failed');
				}
			}).then(() => {
				status.update = null;
				scheduleUpdate(status);
			});
		}, wait);
	}

	// The status's last words, once its turn answered or no answer came in time: nothing changes it
	// after them
	function closeWith(status: Status, closing: 'done' | 'late'): Promise<void> {
		forget(status);
		return inTurn(status, async () => {
			if (status.closed) return;
			status.closed = true;
			const eventId = await status.posted;
			if (eventId === null || status.texts === null) return;
			const { turn } = status;
			try {
				await replace(status, eventId, { msgtype: 'm.text', body: status.texts[closing] });
				log.info({ roomId: turn.roomId, eventId: turn.eventId, closing }, 'status closed');
			} catch (err: unknown) {
				log.warn({ roomId: turn.roomId, eventId: turn.eventId, err }, 'status update failed');
			}
		});
	}

	// No answer came in time, or the role stops: the status says so, and the answer, should it come,
	// goes out as a message of its own
	function giveUp(status: Status): Promise<void> {
		return closeWith(status, 'late');
	}

	// The status takes the reply, once it is out itself: a notice in its place, or, for a question,
	// which goes out on its own, the words that point to it. An answer goes out on its own too, the
	// status saying it is done once it has.
	function replyIn(status: Status, reply: TurnReply): Promise<string | null> {
		return inTurn(status, async () => {
			if (status.closed) return null;
			const eventId = await status.posted;
			const { texts, turn } = status;
			if (eventId === null || texts === null) {
				status.closed = true;
				forget(status);
				return null;
			}
			if (reply.kind === 'answer') return null;
			if (reply.kind === 'question') {
				status.closed = true;
				forget(status);
				try {
					await replace(status, eventId, { msgtype: 'm.text', body: texts.asking });
				} catch (err: unknown) {
					log.warn({ roomId: turn.roomId, eventId: turn.eventId, err }, 'status update failed');
				}
				return null;
			}
			await replace(status, eventId, reply.content);
			status.closed = true;
			forget(status);
			return eventId;
		});
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
			const session = sessions.get(keyOf(turn));
			if (session !== undefined) {
				session.pending.delete(turn.eventId);
				// Another message of the owner may still be in the works: the assistant keeps typing for it
				if (session.pending.size === 0) await endTyping(turn);
			}
			const status = statuses.get(turn.eventId);
			if (status === undefined) return null;
			if (status.posted === null) {
				// Answered before its status was due: it never shows
				forget(status);
				return null;
			}
			status.answering = true;
			if (status.update !== null) clearTimeout(status.update);
			status.update = null;
			return replyIn(status, reply);
		},
		answerSent: (turn, outcome) => {
			// An answer went out on its own: its status, the only one still open by now, says it is done
			const status = statuses.get(turn.eventId);
			if (status !== undefined && outcome === 'answered') {
				void closeWith(status, 'done');
			}
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
				if (outcome === 'answered') await react(turn, ANSWERED);
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
