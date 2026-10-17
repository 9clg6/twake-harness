import { isRecord } from './json.js';

// The thread of a room's main timeline, as read receipts name it
const MAIN_THREAD = 'main';

// A room event as the matrix role reads it
export interface RoomEvent {
	readonly type?: string;
	readonly sender?: string;
	readonly state_key?: string;
	readonly event_id?: string;
	readonly content?: Record<string, unknown>;
}

// A message of a room the matrix role reads for someone, as it hands it to its subscribers: read
// once, whoever it is read for
export interface ReadMessage {
	readonly roomId: string;
	readonly eventId: string;
	// Who wrote it, by their Matrix id
	readonly sender: string;
	// The words of an m.text, null for a message without words, such as an image or a file
	readonly text: string | null;
	// Whom it mentions, by the Matrix ids its m.mentions names: never the whole room
	readonly mentions: readonly string[];
	// The root of its thread, or main for the room's main timeline, as read receipts name them. An
	// edit reads as main: its relation names the message it replaces, not a thread.
	readonly thread: string;
	// When the matrix role received it, by its own clock
	readonly receivedAt: Date;
}

// The words of a message: the body of an m.text alone
export function textOf(event: RoomEvent): string | null {
	const content = event.content ?? {};
	return content['msgtype'] === 'm.text' && typeof content['body'] === 'string'
		? content['body']
		: null;
}

// The Matrix ids a message's m.mentions names, each once
function mentionsOf(content: Record<string, unknown>): string[] {
	const mentions = content['m.mentions'];
	const userIds = isRecord(mentions) ? mentions['user_ids'] : undefined;
	if (!Array.isArray(userIds)) return [];
	return [...new Set(userIds.filter((userId): userId is string => typeof userId === 'string'))];
}

// The root of the thread a content's relation puts its message in, null when it puts it in none
function threadOf(content: Record<string, unknown>): string | null {
	const relation = content['m.relates_to'];
	if (!isRecord(relation) || relation['rel_type'] !== 'm.thread') return null;
	const root = relation['event_id'];
	return typeof root === 'string' ? root : null;
}

// A message as the matrix role reads it once, from its content, as decrypted when it came
// encrypted: the encryption engine gives the decrypted event the relation the encrypted one left in
// the clear, when its content names none. Null for a message without an id or a sender.
export function messageOf(roomId: string, event: RoomEvent, receivedAt: Date): ReadMessage | null {
	const { event_id: eventId, sender } = event;
	if (eventId === undefined || sender === undefined) return null;
	const content = event.content ?? {};
	return {
		roomId,
		eventId,
		sender,
		text: textOf(event),
		mentions: mentionsOf(content),
		thread: threadOf(content) ?? MAIN_THREAD,
		receivedAt
	};
}
