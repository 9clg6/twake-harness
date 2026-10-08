import type { AnnounceDeps } from './commands.js';
import { isRecord } from './json.js';

const MEMBER_EVENT_TYPE = 'm.room.member';

// The name an assistant goes by in a room, which its member event there carries. Clients show it
// over the name of its profile, which a homeserver may keep from changing, as the platform's does:
// the rooms are where its owner sees the name they gave it, or the one it took after them. It is
// written when it differs, in a room the assistant is in, over the rest of its membership; a
// refusal is thrown.
export async function nameInRoom(
	deps: AnnounceDeps,
	room: { readonly roomId: string; readonly assistantUserId: string },
	name: string
): Promise<'written' | 'unchanged' | 'not_joined'> {
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
	return 'written';
}
