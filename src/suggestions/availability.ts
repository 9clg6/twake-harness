import { z } from 'zod';

import { readJsonColumn, type Tx } from '../db/client.js';

// The job the organizer's suggestion queues for the invitee, run under the invitee's principal: the
// request it must answer, and who asked. The invitee's assistant reads the request row itself,
// which it may as a party to it; the payload carries no slot and no word of the conversation.
export const availabilityPayloadSchema = z.object({
	// The invitee, whose assistant answers
	owner: z.string().min(1),
	// The organizer, whose assistant asked, and whose erasure takes this job too
	organizer: z.string().min(1),
	requestId: z.string().min(1)
});
export type AvailabilityPayload = z.infer<typeof availabilityPayloadSchema>;

// A slot as the invitee's answer keeps it: two ISO instants in the invitee's zone
const storedSlotSchema = z.object({ start: z.string(), end: z.string() });
export type StoredSlot = z.infer<typeof storedSlotSchema>;

// The invitee's answer: the candidate slots their assistant read from their free/busy alone, or
// that it answered nothing, which the organizer's code reads to fall back on its own calendar. Null
// in the row while no assistant answered yet.
export type AvailabilityAnswer =
	{ readonly slots: readonly StoredSlot[] } | { readonly none: true };

const answerSchema = z.union([
	z.object({ slots: z.array(storedSlotSchema) }),
	z.object({ none: z.literal(true) })
]);

export interface AvailabilityRequest {
	readonly id: string;
	readonly organizer: string;
	readonly invitee: string;
	readonly roomId: string;
	readonly eventId: string;
	readonly askedAt: Date;
	readonly periodStart: string;
	readonly periodEnd: string | null;
	readonly askedMinutes: number | null;
	readonly durationMs: number;
	// The call the organizer's model froze at its own first free slot, which the fallback proposes
	// when the invitee answered nothing, or too late
	readonly pendingCallId: string;
	readonly answer: AvailabilityAnswer | null;
}

export interface NewAvailabilityRequest {
	readonly organizer: string;
	readonly invitee: string;
	readonly roomId: string;
	readonly eventId: string;
	readonly askedAt: Date;
	readonly periodStart: string;
	readonly periodEnd: string | null;
	readonly askedMinutes: number | null;
	readonly durationMs: number;
	readonly pendingCallId: string;
}

// The row as the harness keeps it
interface RequestRow {
	id: string;
	organizer: string;
	invitee: string;
	room_id: string;
	event_id: string;
	asked_at: Date;
	period_start: string;
	period_end: string | null;
	asked_minutes: number | null;
	duration_ms: number;
	pending_call_id: string;
	answer: unknown;
}

function toRequest(row: RequestRow): AvailabilityRequest {
	const parsed = answerSchema.safeParse(readJsonColumn(row.answer));
	return {
		id: row.id,
		organizer: row.organizer,
		invitee: row.invitee,
		roomId: row.room_id,
		eventId: row.event_id,
		askedAt: row.asked_at,
		periodStart: row.period_start,
		periodEnd: row.period_end,
		askedMinutes: row.asked_minutes,
		durationMs: row.duration_ms,
		pendingCallId: row.pending_call_id,
		answer: parsed.success ? parsed.data : null
	};
}

// Writes the request, under the organizer's principal: one row per message and per invitee, which
// the unique key keeps from doubling when the suggestion runs again. Resolves to the request's id.
export async function writeAvailabilityRequest(
	tx: Tx,
	request: NewAvailabilityRequest
): Promise<string> {
	const rows = await tx.sql<{ id: string }[]>`
		insert into availability_requests
			(organizer, invitee, room_id, event_id, asked_at, period_start, period_end, asked_minutes,
				duration_ms, pending_call_id)
		values (${request.organizer}, ${request.invitee}, ${request.roomId}, ${request.eventId},
			${request.askedAt}, ${request.periodStart}, ${request.periodEnd}, ${request.askedMinutes},
			${request.durationMs}, ${request.pendingCallId})
		on conflict (organizer, room_id, event_id) do update set
			invitee = excluded.invitee, asked_at = excluded.asked_at,
			period_start = excluded.period_start, period_end = excluded.period_end,
			asked_minutes = excluded.asked_minutes, duration_ms = excluded.duration_ms,
			pending_call_id = excluded.pending_call_id,
			answer = null, answered_at = null
		returning id`;
	return rows[0]?.id ?? '';
}

// The request, under either party's principal: each of them reads the row
export async function findAvailabilityRequest(
	tx: Tx,
	id: string
): Promise<AvailabilityRequest | null> {
	const rows = await tx.sql<RequestRow[]>`
		select id, organizer, invitee, room_id, event_id, asked_at, period_start::text as period_start,
			period_end::text as period_end, asked_minutes, duration_ms, pending_call_id, answer
		from availability_requests where id = ${id}`;
	const row = rows[0];
	return row === undefined ? null : toRequest(row);
}

// The request the organizer's assistant already wrote for this message, which its job finds again
// when it re-reads the answer
export async function findAvailabilityRequestFor(
	tx: Tx,
	organizer: string,
	roomId: string,
	eventId: string
): Promise<AvailabilityRequest | null> {
	const rows = await tx.sql<RequestRow[]>`
		select id, organizer, invitee, room_id, event_id, asked_at, period_start::text as period_start,
			period_end::text as period_end, asked_minutes, duration_ms, pending_call_id, answer
		from availability_requests
		where organizer = ${organizer} and room_id = ${roomId} and event_id = ${eventId}`;
	const row = rows[0];
	return row === undefined ? null : toRequest(row);
}

// The invitee's answer, under their own principal: the candidate slots their assistant read from
// their free/busy alone, or none. An answer already given is left as it is.
export async function answerAvailabilityRequest(
	tx: Tx,
	id: string,
	answer: AvailabilityAnswer
): Promise<void> {
	await tx.sql`
		update availability_requests set answer = ${JSON.stringify(answer)}::jsonb, answered_at = now()
		where id = ${id} and answered_at is null`;
}

// A request that ends, once the proposal is made or given up: nothing of its answer is kept
export async function clearAvailabilityRequest(tx: Tx, id: string): Promise<void> {
	await tx.sql`delete from availability_requests where id = ${id}`;
}

// Everything either party's erasure takes: their requests, as organizer or as invitee
export async function clearAvailabilityRequests(tx: Tx, owner: string): Promise<void> {
	await tx.sql`
		delete from availability_requests where organizer = ${owner} or invitee = ${owner}`;
}

// The candidate slots the invitee's assistant offered, as the organizer's code reads them
export function slotsOf(answer: AvailabilityAnswer | null): readonly StoredSlot[] {
	return answer !== null && 'slots' in answer ? answer.slots : [];
}

// One span an answer names, as absolute instants
export interface Window {
	readonly start: Date;
	readonly end: Date;
}

// The instants an answer names, as absolute spans, for the organizer's code to cross with its own
// free/busy: a slot whose instant does not read names nothing
export function windowsOf(answer: AvailabilityAnswer | null): readonly Window[] {
	const windows: Window[] = [];
	for (const stored of slotsOf(answer)) {
		const start = Date.parse(stored.start);
		const end = Date.parse(stored.end);
		if (!Number.isNaN(start) && !Number.isNaN(end)) {
			windows.push({ start: new Date(start), end: new Date(end) });
		}
	}
	return windows;
}

// The answer the invitee's assistant writes when it cannot answer with slots: no assistant, no
// sharing, or a colleague check that failed. The organizer's code reads it to fall back on its own
// calendar, exactly as it does when nothing answered in time.
export const NO_AVAILABILITY_ANSWER: AvailabilityAnswer = { none: true };

// The queue group of one invitee's availability jobs, so that an invitee answers one request at a
// time and a job never waits behind the organizer's own suggestions
export function availabilityGroup(invitee: string): string {
	return `availability:${invitee}`;
}
