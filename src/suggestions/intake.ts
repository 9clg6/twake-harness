import type { FastifyBaseLogger } from 'fastify';

import { findAssistant } from '../assistants/repository.js';
import type { Config } from '../config.js';
import { withPrincipal, type Db } from '../db/client.js';
import { enqueueJob } from '../jobs/queue.js';
import { principalOfMatrixUser } from '../principals/identity.js';
import { suggestGroup, type Quoted, type SuggestPayload } from './job.js';
import { mayArrangeMeeting } from './prefilter.js';
import { noteRoom, readRoom, readSettings, type RoomFlags } from './repository.js';

// A message stays context for the next one for this long; it lives in this process's memory only
const CONTEXT_TTL_MS = 15 * 60 * 1000;
const MAX_ROOMS_IN_MEMORY = 2000;
const FLAGS_TTL_MS = 60 * 1000;

interface Remembered extends Quoted {
	readonly eventId: string;
	readonly at: number;
}

export interface StateEvent {
	readonly type?: string | undefined;
	readonly state_key?: string | undefined;
	readonly content?: Record<string, unknown> | undefined;
}

export interface ChannelMessage {
	readonly sender: string;
	readonly eventId: string;
	readonly text: string;
}

export interface SuggestionIntake {
	// An event of a room reached the application service encrypted
	noteEncrypted(roomId: string): Promise<void>;
	// A state event Synapse pushed: what marks a room as a channel, as encrypted, or as switched off
	noteState(roomId: string, event: StateEvent): Promise<void>;
	// A clear message of a room the assistants are not in
	onMessage(roomId: string, message: ChannelMessage): Promise<void>;
}

export interface IntakeDeps {
	readonly config: Config;
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	readonly now?: () => number;
}

// The messages of channels the assistants have not joined come to the matrix role because the
// registration asks for the rooms of the homeserver. Nothing here reads a room: a message is
// looked at for the time it takes to decide, the last one of each room is held in memory as
// context for the next, and a job per member who may be offered something carries the quotes.
export function makeSuggestionIntake(deps: IntakeDeps): SuggestionIntake {
	const { config, db, log } = deps;
	const now = deps.now ?? Date.now;
	const recent = new Map<string, Remembered>();
	const flags = new Map<string, { readonly flags: RoomFlags; readonly until: number }>();

	// A room is read only if Synapse pushed what makes it a channel (it is a space, or inside one),
	// and nothing that takes it out: encryption, or the room's own switch. Anything else is ignored,
	// a room that existed before the registration included, until such a state event is pushed.
	async function analysable(roomId: string): Promise<boolean> {
		let known = flags.get(roomId);
		if (known === undefined || known.until <= now()) {
			known = { flags: await readRoom(db, roomId), until: now() + FLAGS_TTL_MS };
			flags.set(roomId, known);
		}
		const { channel, encrypted, disabled } = known.flags;
		return channel && !encrypted && !disabled;
	}

	function remember(roomId: string, message: Remembered): void {
		recent.delete(roomId);
		recent.set(roomId, message);
		if (recent.size > MAX_ROOMS_IN_MEMORY) {
			const oldest = recent.keys().next();
			if (oldest.done !== true) recent.delete(oldest.value);
		}
	}

	async function enabled(owner: string): Promise<boolean> {
		return (await withPrincipal(db, { id: owner }, (tx) => readSettings(tx, owner))).enabled;
	}

	async function hasAssistant(owner: string): Promise<boolean> {
		const assistant = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
		return assistant !== null && assistant.deletedAt === null;
	}

	return {
		async noteEncrypted(roomId) {
			if (!config.suggestions.enabled) return;
			recent.delete(roomId);
			flags.delete(roomId);
			await noteRoom(db, roomId, { encrypted: true });
		},
		async noteState(roomId, event) {
			if (!config.suggestions.enabled || event.state_key === undefined) return;
			const content = event.content ?? {};
			let seen: Parameters<typeof noteRoom>[2] | null = null;
			// A space is a channel; so is a room that names a space as its parent (a parent removed
			// has an empty content)
			if (
				event.type === 'm.room.create' &&
				event.state_key === '' &&
				content['type'] === 'm.space'
			) {
				seen = { channel: true };
			} else if (event.type === 'm.space.parent' && Array.isArray(content['via'])) {
				seen = { channel: true };
			} else if (event.type === 'm.room.encryption' && event.state_key === '') {
				seen = { encrypted: true };
			} else if (event.type === 'app.twake.chat.suggestions' && event.state_key === '') {
				seen = { disabled: content['enabled'] === false };
			}
			if (seen === null) return;
			if (seen.encrypted === true) recent.delete(roomId);
			flags.delete(roomId);
			await noteRoom(db, roomId, seen);
		},
		async onMessage(roomId, message) {
			if (!config.suggestions.enabled) return;
			const sender = principalOfMatrixUser(config, message.sender);
			if (sender === null) return;
			if (!(await analysable(roomId))) {
				recent.delete(roomId);
				return;
			}
			const current: Remembered = {
				author: message.sender,
				email: sender,
				text: message.text.slice(0, 600),
				eventId: message.eventId,
				at: now()
			};
			const previous = recent.get(roomId);
			remember(roomId, current);
			if (!mayArrangeMeeting(message.text)) return;
			// Whoever turned suggestions off is not read: not as the message that starts one, nor as its context
			if (!(await enabled(sender))) {
				log.info({ roomId, eventId: message.eventId, reason: 'opted out' }, 'channel ignored');
				return;
			}
			let context: Remembered | null =
				previous !== undefined &&
				previous.eventId !== message.eventId &&
				now() - previous.at <= CONTEXT_TTL_MS
					? previous
					: null;
			if (context !== null && context.email !== sender && !(await enabled(context.email))) {
				context = null;
			}
			const quoted: Quoted[] = [context, current]
				.filter((item): item is Remembered => item !== null)
				.map(({ author, email, text }) => ({ author, email, text }));
			// The conversation pair: whoever wrote the message and whoever wrote the one before
			const owners = [...new Set(quoted.map((q) => q.email))];
			let queued = 0;
			for (const owner of owners) {
				if (!(await hasAssistant(owner))) continue;
				const payload: SuggestPayload = {
					owner,
					roomId,
					eventId: message.eventId,
					at: now(),
					quoted
				};
				const added = await enqueueJob(db, {
					kind: 'suggest',
					payload,
					dedupKey: `suggest:${message.eventId}:${owner}`,
					groupKey: suggestGroup(owner)
				});
				if (added) queued += 1;
			}
			log.info(
				{ roomId, eventId: message.eventId, candidates: owners.length, queued },
				'suggestions queued'
			);
		}
	};
}
