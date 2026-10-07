import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '../config.js';
import { withPrincipal, type Db } from '../db/client.js';
import { fetchOwnerMessages } from './locale.js';
import type { MatrixAdmin } from '../matrix/admin.js';
import { announceCommands } from '../matrix/commands.js';
import { assistantUserId } from '../matrix/registration.js';
import { matrixLocalpartOfPrincipal } from '../principals/identity.js';
import {
	findAssistant,
	markAssistantDeleted,
	renameAssistant,
	saveAssistant,
	saveAssistantRoom,
	saveProvisioned,
	setAssistantRoomId,
	type AssistantRecord
} from './repository.js';

export interface AssistantView {
	readonly userId: string;
	readonly name: string;
	readonly roomId: string | null;
	readonly link: string;
}

export type CreateResult =
	| { readonly ok: true; readonly assistant: AssistantView }
	| {
			readonly ok: false;
			readonly reason: 'exists' | 'invalid_name' | 'not_on_homeserver' | 'failed';
	  };

export type ProvisionResult =
	| { readonly ok: true; readonly userId: string }
	| { readonly ok: false; readonly reason: 'not_on_homeserver' | 'failed' };

export interface AssistantService {
	create(owner: string, name: string): Promise<CreateResult>;
	// The owner's assistant as a provisioner asks for it: the live one, or a new one under the
	// default name, without a room of its own, since the owner's client opens the direct room
	provision(owner: string): Promise<ProvisionResult>;
	find(owner: string): Promise<AssistantView | null>;
	rename(owner: string, name: string): Promise<AssistantView | null>;
	remove(owner: string): Promise<boolean>;
}

export interface AssistantServiceDeps {
	readonly config: Config;
	readonly db: Db;
	readonly admin: MatrixAdmin;
	readonly log: FastifyBaseLogger;
}

const NAME = /^[^\p{C}]{1,64}$/u;

export function isValidAssistantName(name: string): boolean {
	return NAME.test(name.trim()) && name.trim().length > 0;
}

function matrixLink(userId: string): string {
	return `https://matrix.to/#/${userId}`;
}

function toView(record: Pick<AssistantRecord, 'userId' | 'name' | 'roomId'>): AssistantView {
	return {
		userId: record.userId,
		name: record.name,
		roomId: record.roomId,
		link: matrixLink(record.userId)
	};
}

export function makeAssistantService(deps: AssistantServiceDeps): AssistantService {
	const { config, db, admin, log } = deps;

	async function current(owner: string): Promise<AssistantRecord | null> {
		const record = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
		return record === null || record.deletedAt !== null ? null : record;
	}

	// Takes back what a failed creation made, so the owner's next /newbot starts clean. The row goes
	// back to deleted. A room exists only when the failure came after it: the assistant leaves it,
	// and the owner's invitation stays, since the owner holds the same power and cannot be kicked.
	async function undoCreation(
		owner: string,
		userId: string,
		roomId: string | null,
		saved: boolean
	): Promise<void> {
		if (saved) {
			try {
				await withPrincipal(db, { id: owner }, (tx) => markAssistantDeleted(tx, owner));
			} catch (err: unknown) {
				log.warn({ owner, userId, err }, 'failed creation not undone');
			}
		}
		if (roomId !== null) {
			try {
				await admin.leaveRoom(userId, roomId);
			} catch (err: unknown) {
				log.warn({ userId, roomId, err }, 'room not left');
			}
		}
	}

	return {
		async create(owner, rawName) {
			const name = rawName.trim();
			if (!isValidAssistantName(name)) return { ok: false, reason: 'invalid_name' };
			if ((await current(owner)) !== null) return { ok: false, reason: 'exists' };
			// The owner needs an account on our homeserver, where the assistant opens the room
			const ownerLocalpart = matrixLocalpartOfPrincipal(config, owner);
			if (ownerLocalpart === null) return { ok: false, reason: 'not_on_homeserver' };
			const userId = assistantUserId(config, ownerLocalpart);
			const ownerUserId = `@${ownerLocalpart}:${config.matrix.serverName}`;
			const localpart = `${config.matrix.assistantPrefix}${ownerLocalpart}`;
			let saved = false;
			let roomId: string | null = null;
			try {
				// The account is registered once and kept, since a Matrix identifier is never reused;
				// its device belongs to the application service, which creates and keeps it.
				await admin.registerUser(localpart);
				const named = await admin.setDisplayName(userId, name);
				// Saved before its room exists: a save that fails, as when another row still holds the
				// account, leaves nothing behind on the homeserver
				const { reclaimed } = await withPrincipal(db, { id: owner }, (tx) =>
					saveAssistant(tx, { owner, userId, name, roomId: null })
				);
				saved = true;
				const opened = await admin.createDirectRoom(userId, ownerUserId);
				roomId = opened;
				// The greeting waits for the owner to join: the matrix role then encrypts it for their
				// devices. The room and its index land together or not at all.
				// A first assistant greets in the deployment's language; one created again, in the
				// language its owner chose for the one before
				const toOwner = await fetchOwnerMessages(db, owner, config.locale);
				const welcome = toOwner.welcome(name);
				await withPrincipal(db, { id: owner }, async (tx) => {
					await setAssistantRoomId(tx, owner, opened);
					await saveAssistantRoom(tx, { roomId: opened, owner, userId, welcome });
				});
				log.info({ owner, userId, roomId: opened, named, reclaimed }, 'assistant created');
				// As in every room of the assistant: the client offers them after « / »
				await announceCommands(
					{ admin, log },
					{ roomId: opened, assistantUserId: userId },
					toOwner
				);
				return {
					ok: true,
					assistant: toView({ userId, name, roomId: opened })
				};
			} catch (err: unknown) {
				log.error({ owner, userId, roomId, err }, 'assistant creation failed');
				await undoCreation(owner, userId, roomId, saved);
				return { ok: false, reason: 'failed' };
			}
		},
		async provision(owner) {
			const live = await current(owner);
			if (live !== null) {
				await saveProvisioned(db, owner, live.userId);
				return { ok: true, userId: live.userId };
			}
			const ownerLocalpart = matrixLocalpartOfPrincipal(config, owner);
			if (ownerLocalpart === null) return { ok: false, reason: 'not_on_homeserver' };
			const userId = assistantUserId(config, ownerLocalpart);
			const localpart = `${config.matrix.assistantPrefix}${ownerLocalpart}`;
			const name = (await fetchOwnerMessages(db, owner, config.locale)).defaultAssistantName;
			try {
				// The account is registered once and kept, as for an assistant the owner creates
				await admin.registerUser(localpart);
				const named = await admin.setDisplayName(userId, name);
				const { reclaimed } = await withPrincipal(db, { id: owner }, (tx) =>
					saveAssistant(tx, { owner, userId, name, roomId: null })
				);
				await saveProvisioned(db, owner, userId);
				log.info({ owner, userId, named, reclaimed }, 'assistant provisioned');
				return { ok: true, userId };
			} catch (err: unknown) {
				log.error({ owner, userId, err }, 'assistant provisioning failed');
				return { ok: false, reason: 'failed' };
			}
		},
		async find(owner) {
			const record = await current(owner);
			return record === null ? null : toView(record);
		},
		async rename(owner, rawName) {
			const name = rawName.trim();
			if (!isValidAssistantName(name)) return null;
			const record = await current(owner);
			if (record === null) return null;
			await admin.setDisplayName(record.userId, name);
			await withPrincipal(db, { id: owner }, (tx) => renameAssistant(tx, owner, name));
			// The name is the owner's own text: only debug carries it, as with conversations
			log.info({ owner, userId: record.userId }, 'assistant renamed');
			log.debug({ owner, userId: record.userId, name }, 'assistant renamed');
			return toView({ ...record, name });
		},
		async remove(owner) {
			const record = await current(owner);
			if (record === null) return false;
			// The assistant leaves and goes dormant with its device, which the application service
			// keeps: a device it no longer drives would fail every later transaction that names it.
			if (record.roomId !== null) {
				await admin.leaveRoom(record.userId, record.roomId);
			}
			await withPrincipal(db, { id: owner }, (tx) => markAssistantDeleted(tx, owner));
			await db.sql`delete from assistant_rooms where owner = ${owner}`;
			await db.sql`delete from assistant_provisioned where owner = ${owner}`;
			log.info({ owner, userId: record.userId }, 'assistant deleted');
			return true;
		}
	};
}
