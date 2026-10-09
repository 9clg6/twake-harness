import { isRecord } from './json.js';

// The read receipts that tell a user read a room, public and private
const READ_RECEIPTS = ['m.read', 'm.read.private'];

// The room of a read receipt Synapse pushes, and the users it says read there, public or private,
// whatever event each one read: null for any other ephemeral event
export function readersOf(
	event: Record<string, unknown>
): { readonly roomId: string; readonly userIds: ReadonlySet<string> } | null {
	const roomId = event['room_id'];
	const content = event['content'];
	if (event['type'] !== 'm.receipt' || typeof roomId !== 'string' || !isRecord(content)) {
		return null;
	}
	const userIds = new Set<string>();
	for (const receipts of Object.values(content)) {
		if (!isRecord(receipts)) continue;
		for (const type of READ_RECEIPTS) {
			const users = receipts[type];
			if (isRecord(users)) for (const userId of Object.keys(users)) userIds.add(userId);
		}
	}
	return { roomId, userIds };
}
