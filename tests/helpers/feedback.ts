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

// What the owner sees of their assistant at work in its room: its reactions on an event, and
// whether it is typing
export interface RoomFeedback {
	reactionsOn(eventId: string): Reaction[];
	isRedacted(eventId: string): boolean;
	isTyping(): Promise<boolean>;
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
		isRedacted: (eventId) =>
			client.events.some(
				(e) => e.roomId === room && e.type === 'm.room.redaction' && e.redacts === eventId
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
