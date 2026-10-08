import type { FastifyBaseLogger } from 'fastify';

import type { MatrixAdmin } from './admin.js';

const MEMBER_EVENT_TYPE = 'm.room.member';

export interface NamingDeps {
	readonly admin: MatrixAdmin;
	readonly log: FastifyBaseLogger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The name an assistant goes by in a room, which its member event there carries: clients show it
// over the name of its profile, which a homeserver may keep from changing. It is written when it
// differs, in a room the assistant is in, over the rest of its membership; a refusal is thrown.
export async function nameInRoom(
	deps: NamingDeps,
	room: { readonly roomId: string; readonly assistantUserId: string },
	name: string
): Promise<'named' | 'unchanged' | 'not_joined'> {
	const { roomId, assistantUserId } = room;
	const current = await deps.admin.readState(
		assistantUserId,
		roomId,
		MEMBER_EVENT_TYPE,
		assistantUserId
	);
	const member = isRecord(current) ? current : {};
	if (member['membership'] !== 'join') return 'not_joined';
	if (member['displayname'] === name) return 'unchanged';
	await deps.admin.writeState(assistantUserId, roomId, MEMBER_EVENT_TYPE, assistantUserId, {
		...member,
		displayname: name
	});
	deps.log.info({ roomId, userId: assistantUserId }, 'assistant named in its room');
	return 'named';
}
