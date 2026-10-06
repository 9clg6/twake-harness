import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '../config.js';
import { withPrincipal, type Db } from '../db/client.js';
import type { MatrixAdmin } from '../matrix/admin.js';
import { assistantUserId } from '../matrix/registration.js';
import {
	findAssistant,
	markAssistantDeleted,
	renameAssistant,
	saveAssistant,
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
	| { readonly ok: false; readonly reason: 'exists' | 'invalid_name' };

export interface AssistantService {
	create(owner: string, name: string): Promise<CreateResult>;
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

export function ownerMatrixId(config: Config, owner: string): string {
	return `@${owner}:${config.matrix.serverName}`;
}

function matrixLink(userId: string): string {
	return `https://matrix.to/#/${userId}`;
}

function toView(record: AssistantRecord): AssistantView {
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

	return {
		async create(owner, rawName) {
			const name = rawName.trim();
			if (!isValidAssistantName(name)) return { ok: false, reason: 'invalid_name' };
			if ((await current(owner)) !== null) return { ok: false, reason: 'exists' };
			const userId = assistantUserId(config, owner);
			const localpart = `${config.matrix.assistantPrefix}${owner}`;
			// The account is registered once and kept, since a Matrix identifier is never reused;
			// its device belongs to the application service, which creates and keeps it.
			await admin.registerUser(localpart);
			const named = await admin.setDisplayName(userId, name);
			const roomId = await admin.createDirectRoom(userId, ownerMatrixId(config, owner));
			await withPrincipal(db, { id: owner }, (tx) =>
				saveAssistant(tx, { owner, userId, name, roomId })
			);
			// The greeting waits for the owner to join: the matrix role then encrypts it for their devices
			const welcome = `Hello, I am ${name}, your Twake Space assistant. Tell me what you need; I remember what matters and I ask before I act.`;
			await db.sql`
				insert into assistant_rooms (room_id, owner, user_id, welcome) values (${roomId}, ${owner}, ${userId}, ${welcome})
				on conflict (room_id) do update set owner = excluded.owner, user_id = excluded.user_id, welcome = excluded.welcome`;
			log.info({ owner, userId, roomId, named }, 'assistant created');
			return { ok: true, assistant: toView({ owner, userId, name, roomId, deletedAt: null }) };
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
			log.info({ owner, userId: record.userId, name }, 'assistant renamed');
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
			log.info({ owner, userId: record.userId }, 'assistant deleted');
			return true;
		}
	};
}
