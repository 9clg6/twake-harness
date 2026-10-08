import { expect } from 'vitest';

import type { E2eeClient } from './e2ee-client.js';
import type { MatrixUser, TestSynapse } from './synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// A reaction of the assistant on an event of its room, as the owner's client reads it
export interface Reaction {
	readonly eventId: string;
	readonly key: string;
}

// An edit of a message: the content the owner's client shows in the message's place
export interface Edit {
	readonly eventId: string;
	readonly content: Record<string, unknown>;
	// When the homeserver received it
	readonly at: number;
}

// A message of the assistant as the owner's client shows it: the content of its latest edit, in
// its place, or else its own
export interface ShownMessage {
	readonly eventId: string;
	readonly body: string;
	readonly content: Record<string, unknown>;
	// The message as it was sent, when the homeserver received it, and its edits in the order they
	// came
	readonly original: Record<string, unknown>;
	readonly at: number;
	readonly edits: readonly Edit[];
}

// The event a message answers as a reply, or null when it is no reply
export function inReplyTo(content: Record<string, unknown>): string | null {
	const relation = content['m.relates_to'] as Record<string, unknown> | undefined;
	const reply = relation?.['m.in_reply_to'] as Record<string, unknown> | undefined;
	return typeof reply?.['event_id'] === 'string' ? reply['event_id'] : null;
}

// What the owner sees of their assistant at work in its room: its reactions on an event, whether
// it is typing, and its messages, edits applied
export interface RoomFeedback {
	reactionsOn(eventId: string): Reaction[];
	redactedEventIds(): string[];
	isTyping(): Promise<boolean>;
	shown(): ShownMessage[];
}

export interface RoomFeedbackOptions {
	readonly synapse: TestSynapse;
	readonly owner: MatrixUser;
	readonly client: E2eeClient;
	readonly room: string;
	readonly assistantId: string;
}

// Synapse caches a sync answer under its parameters, timeout included; a sync without a token
// answers at once whatever the timeout, so a new one per call reads the present state
let syncs = 0;

export function watchFeedback(options: RoomFeedbackOptions): RoomFeedback {
	const { synapse, owner, client, room, assistantId } = options;
	return {
		reactionsOn: (eventId) =>
			client.events
				.filter((e) => e.roomId === room && e.type === 'm.reaction' && e.sender === assistantId)
				.flatMap((e) => {
					const relation = e.content['m.relates_to'] as Record<string, unknown> | undefined;
					return relation?.['rel_type'] === 'm.annotation' && relation['event_id'] === eventId
						? [{ eventId: e.eventId, key: String(relation['key']) }]
						: [];
				}),
		redactedEventIds: () =>
			client.events.flatMap((e) =>
				e.roomId === room && e.type === 'm.room.redaction' && e.sender === assistantId
					? [e.redacts ?? '']
					: []
			),
		// Typing notifications are ephemeral: the SDK client drops them, a sync without a token shows
		// who is typing in the room right now
		isTyping: async () => {
			// Emptier filters (no state, no account data) make Synapse leave the room out altogether
			const filter = { room: { rooms: [room], timeline: { limit: 0 } } };
			const sync = await synapse.request(
				owner,
				'GET',
				`/_matrix/client/v3/sync?timeout=${(syncs += 1)}&filter=${encodeURIComponent(JSON.stringify(filter))}`
			);
			const rooms = (sync.body['rooms'] as { join?: Record<string, unknown> } | undefined)?.join;
			const joined = rooms?.[room] as { ephemeral?: { events?: unknown[] } } | undefined;
			return (joined?.ephemeral?.events ?? []).some((event) => {
				const typing = event as { type?: string; content?: { user_ids?: string[] } };
				return typing.type === 'm.typing' && (typing.content?.user_ids ?? []).includes(assistantId);
			});
		},
		// A client shows an edit (m.replace) of a message in the message's place, and only from the
		// message's own sender
		shown: () => {
			const messages: {
				eventId: string;
				original: Record<string, unknown>;
				at: number;
				edits: Edit[];
			}[] = [];
			for (const e of client.events) {
				if (e.roomId !== room || e.sender !== assistantId || e.type !== 'm.room.message') continue;
				const relation = e.content['m.relates_to'] as Record<string, unknown> | undefined;
				const replacement = e.content['m.new_content'];
				if (relation?.['rel_type'] === 'm.replace') {
					const edited = messages.find((m) => m.eventId === relation['event_id']);
					if (typeof replacement === 'object' && replacement !== null) {
						edited?.edits.push({
							eventId: e.eventId,
							content: replacement as Record<string, unknown>,
							at: e.at
						});
					}
					continue;
				}
				messages.push({ eventId: e.eventId, original: e.content, at: e.at, edits: [] });
			}
			return messages.map((m) => {
				const content = m.edits.at(-1)?.content ?? m.original;
				return { ...m, content, body: String(content['body'] ?? '') };
			});
		}
	};
}

// Reads until the value is there, or the time is up, then reads it a last time
export async function eventually<T>(read: () => T | Promise<T>, timeoutMs = 15_000): Promise<T> {
	for (let i = 0; i < timeoutMs / 200; i += 1) {
		const value = await read();
		if (value !== undefined && value !== false) return value;
		await sleep(200);
	}
	return read();
}

// An answered message keeps the eyes the assistant put on it, the check mark after them: in an
// encrypted room, the homeserver keeps a redacted reaction as an empty encrypted event, which some
// clients show as a message they cannot read
export async function expectAnswered(feedback: RoomFeedback, eventId: string): Promise<void> {
	await eventually(() => feedback.reactionsOn(eventId).some((r) => r.key === '✅'));
	expect(feedback.reactionsOn(eventId).map((r) => r.key)).toEqual(['👀', '✅']);
	expect(feedback.redactedEventIds()).toEqual([]);
}

// A message whose turn failed or was refused keeps its eyes and gets no check mark, once what would
// come late has had a second to show
export async function expectSeenOnly(feedback: RoomFeedback, eventId: string): Promise<void> {
	await sleep(1000);
	expect(feedback.reactionsOn(eventId).map((r) => r.key)).toEqual(['👀']);
	expect(feedback.redactedEventIds()).toEqual([]);
}
