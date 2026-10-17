import { isRecord } from './json.js';

// The read receipt that tells a user read a room. A private one (`m.read.private`) is theirs alone:
// the Matrix specification keeps it from an application service, as Synapse does from 1.162 on, so
// it counts nowhere, even where an older Synapse still pushes it.
const READ_RECEIPT = 'm.read';

// A public read receipt the matrix role read: who read a room up to which message
export interface ReadReceipt {
	readonly roomId: string;
	// Who read, by their Matrix id
	readonly userId: string;
	// The message they read up to
	readonly eventId: string;
	// The thread it covers, its root or main, when it names one: null for a receipt that names none,
	// as Synapse pushes them
	readonly thread: string | null;
	// When the matrix role received it, by its own clock, whatever time the receipt carries
	readonly receivedAt: Date;
}

// The public read receipts of a receipt event Synapse pushes, one per user and message, received
// at the instant given: none for any other ephemeral event
export function receiptsOf(event: Record<string, unknown>, receivedAt: Date): ReadReceipt[] {
	const roomId = event['room_id'];
	const content = event['content'];
	if (event['type'] !== 'm.receipt' || typeof roomId !== 'string' || !isRecord(content)) {
		return [];
	}
	const receipts: ReadReceipt[] = [];
	for (const [eventId, byType] of Object.entries(content)) {
		const users = isRecord(byType) ? byType[READ_RECEIPT] : undefined;
		if (!isRecord(users)) continue;
		for (const [userId, receipt] of Object.entries(users)) {
			const thread = isRecord(receipt) ? receipt['thread_id'] : undefined;
			receipts.push({
				roomId,
				userId,
				eventId,
				thread: typeof thread === 'string' ? thread : null,
				receivedAt
			});
		}
	}
	return receipts;
}
