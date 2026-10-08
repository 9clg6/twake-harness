import type { FastifyBaseLogger } from 'fastify';
import type { Intent } from 'matrix-bot-sdk';

import type { Config } from '../config.js';
import type { MatrixAdmin } from '../matrix/admin.js';

export function listenerUserId(config: Config): string {
	return `@${config.suggestions.userLocalpart}:${config.matrix.serverName}`;
}

const DISPLAY_NAMES = { en: 'Twake Assistant', fr: 'Assistant Twake' } as const;

interface StateEvent {
	readonly type?: unknown;
	readonly state_key?: unknown;
	readonly content?: unknown;
}

// Why a room is no channel to listen to, or null when it is one: any room that is not encrypted
export function whyNotAChannel(state: readonly StateEvent[]): string | null {
	return state.some((event) => event.type === 'm.room.encryption') ? 'encrypted' : null;
}

export interface InviteEvent {
	readonly content?: Record<string, unknown> | undefined;
	readonly unsigned?: Record<string, unknown> | undefined;
}

export interface ChannelListenerDeps {
	readonly config: Config;
	readonly admin: MatrixAdmin;
	readonly intent: Intent;
	readonly log: FastifyBaseLogger;
	// A room the listener left or was removed from: what is kept of it is forgotten
	readonly forget: (roomId: string) => void;
}

export interface ChannelListener {
	// Registers the listener user, names it, and checks again the rooms it is in
	start(): Promise<void>;
	// Whether the listener is in this room, which is a channel it was invited to
	has(roomId: string): boolean;
	// The listener was invited: it joins a room that is not encrypted, and declines a direct or an
	// encrypted one
	onInvite(roomId: string, event: InviteEvent): Promise<void>;
	// The listener left a room, or was kicked or banned from it: that is the room's switch
	onMember(roomId: string, event: { content?: Record<string, unknown> | undefined }): void;
	// A room the listener is in turned encrypted, or sent an encrypted event: it leaves at once
	onEncrypted(roomId: string): Promise<void>;
	// Suggestions are off: the listener leaves the rooms it is still in from a time they were on, as
	// its presence would tell their members that it reads them. Best effort and quiet, as are the
	// two below: a listener never registered is in none, and is not made to exist for it.
	standDown(): Promise<void>;
	// Suggestions are off: an invite of the listener is declined
	decline(roomId: string): Promise<void>;
}

// The one visible user that reads channels (see Suggestions in the README). It is a member of the
// rooms it was invited to, Synapse pushes those rooms and no other, and it never writes in them.
export function makeChannelListener(deps: ChannelListenerDeps): ChannelListener {
	const { config, admin, intent, log } = deps;
	const channels = new Set<string>();

	async function stateOf(roomId: string): Promise<StateEvent[]> {
		return (await intent.underlyingClient.getRoomState(roomId)) as StateEvent[];
	}

	async function leave(roomId: string, reason: string): Promise<void> {
		channels.delete(roomId);
		deps.forget(roomId);
		try {
			await intent.leaveRoom(roomId, reason);
		} catch (err: unknown) {
			log.warn({ roomId, err }, 'listener could not leave a room');
		}
	}

	// Through the client the intent wraps, which registers no user first; false when it could not
	async function leaveWhileOff(roomId: string): Promise<boolean> {
		channels.delete(roomId);
		deps.forget(roomId);
		try {
			await intent.underlyingClient.leaveRoom(roomId, 'off');
			return true;
		} catch {
			return false;
		}
	}

	return {
		async start() {
			const { userLocalpart } = config.suggestions;
			await admin.registerUser(userLocalpart);
			await admin.setDisplayName(listenerUserId(config), DISPLAY_NAMES[config.locale]);
			for (const roomId of await intent.underlyingClient.getJoinedRooms()) {
				const why = whyNotAChannel(await stateOf(roomId));
				if (why === null) {
					channels.add(roomId);
				} else {
					log.info({ roomId, reason: why }, 'listener left a room');
					await leave(roomId, why);
				}
			}
			log.info({ userId: listenerUserId(config), channels: channels.size }, 'listener ready');
		},
		has: (roomId) => channels.has(roomId),
		async onInvite(roomId, event) {
			const declined = async (reason: string): Promise<void> => {
				log.info({ roomId, reason }, 'listener declined an invite');
				await leave(roomId, reason);
			};
			// A direct room is private
			if (event.content?.['is_direct'] === true) return declined('direct');
			// The stripped state of the invite already tells a room that is encrypted
			const stripped = event.unsigned?.['invite_room_state'];
			if (Array.isArray(stripped) && whyNotAChannel(stripped as StateEvent[]) === 'encrypted') {
				return declined('encrypted');
			}
			await intent.joinRoom(roomId);
			// Read again once in, in case the stripped state left the encryption out
			let why: string | null;
			try {
				why = whyNotAChannel(await stateOf(roomId));
			} catch (err: unknown) {
				// A room it cannot read is no channel
				await leave(roomId, 'unreadable');
				throw err;
			}
			if (why !== null) return declined(why);
			channels.add(roomId);
			log.info({ roomId }, 'listener joined a channel');
		},
		onMember(roomId, event) {
			const membership = event.content?.['membership'];
			if (membership !== 'leave' && membership !== 'ban') return;
			if (channels.delete(roomId)) {
				deps.forget(roomId);
				log.info({ roomId, membership }, 'listener removed from a channel');
			}
		},
		async onEncrypted(roomId) {
			if (!channels.has(roomId)) return;
			log.info({ roomId, reason: 'encrypted' }, 'listener left a room');
			await leave(roomId, 'encrypted');
		},
		async standDown() {
			let rooms: string[];
			try {
				rooms = await intent.underlyingClient.getJoinedRooms();
			} catch {
				return;
			}
			let left = 0;
			for (const roomId of rooms) if (await leaveWhileOff(roomId)) left += 1;
			if (rooms.length > 0) {
				log.info({ rooms: rooms.length, left }, 'listener left its rooms: suggestions are off');
			}
		},
		async decline(roomId) {
			if (await leaveWhileOff(roomId)) {
				log.info({ roomId, reason: 'off' }, 'listener declined an invite');
			}
		}
	};
}
