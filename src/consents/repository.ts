import { readJsonColumn, type Tx } from '../db/client.js';
import type { TurnOrigin } from '../agent/tools.js';
import type { ConsentLevel, ConsentSource, WaitReason } from './consent.js';

export async function hasConsent(
	tx: Tx,
	owner: string,
	domain: string,
	level: ConsentLevel
): Promise<boolean> {
	const rows = await tx.sql`
		select 1 from consents where owner = ${owner} and domain = ${domain} and level = ${level}`;
	return rows.length > 0;
}

export async function grantConsent(
	tx: Tx,
	owner: string,
	domain: string,
	level: ConsentLevel,
	source: ConsentSource
): Promise<void> {
	await tx.sql`
		insert into consents (owner, domain, level, granted_by)
		values (${owner}, ${domain}, ${level}, ${source})
		on conflict do nothing`;
}

export interface PendingCallInput {
	readonly owner: string;
	readonly tool: string;
	readonly contract: string;
	readonly domain: string;
	readonly level: ConsentLevel;
	readonly reasons: readonly WaitReason[];
	readonly arguments: unknown;
	readonly correlationId: string | null;
	readonly origin: TurnOrigin;
}

// Freezes a call until its owner answers; resolves to its id
export async function insertPendingCall(tx: Tx, input: PendingCallInput): Promise<string> {
	const rows = await tx.sql<{ id: string }[]>`
		insert into pending_calls (owner, tool, contract, domain, level, reasons, arguments,
			correlation_id, origin)
		values (${input.owner}, ${input.tool}, ${input.contract}, ${input.domain}, ${input.level},
			${JSON.stringify(input.reasons)}::jsonb, ${JSON.stringify(input.arguments)}::jsonb,
			${input.correlationId}, ${input.origin})
		returning id`;
	const row = rows[0];
	if (row === undefined) throw new Error('the pending call was not stored');
	return row.id;
}

// The Matrix event of the question asked about a call, which its owner's answer points to;
// false when no such call is stored, so that no answer could ever find it
export async function recordRequestEvent(tx: Tx, id: string, eventId: string): Promise<boolean> {
	const result =
		await tx.sql`update pending_calls set request_event_id = ${eventId} where id = ${id}`;
	return result.count === 1;
}

// The call still waiting for an answer to the question asked in this event, if any
export async function findOpenRequest(
	tx: Tx,
	owner: string,
	requestEventId: string
): Promise<string | null> {
	const rows = await tx.sql<{ id: string }[]>`
		select id from pending_calls
		where owner = ${owner} and request_event_id = ${requestEventId} and status = 'open'`;
	return rows[0]?.id ?? null;
}

export interface ApprovedCall {
	readonly tool: string;
	readonly contract: string;
	readonly domain: string;
	readonly level: ConsentLevel;
	readonly arguments: unknown;
	readonly correlationId: string | null;
	readonly origin: TurnOrigin;
}

interface ApprovedRow {
	tool: string;
	contract: string;
	domain: string;
	level: ConsentLevel;
	arguments: unknown;
	correlation_id: string | null;
	origin: TurnOrigin;
}

// Approves a call still waiting, once: a second answer, or one to a call already run, finds
// nothing. A call approved but never run, its answer's job having died, is handed out again.
export async function approvePendingCall(
	tx: Tx,
	owner: string,
	id: string
): Promise<ApprovedCall | null> {
	const rows = await tx.sql<ApprovedRow[]>`
		update pending_calls set status = 'approved', decided_at = coalesce(decided_at, now())
		where id = ${id} and owner = ${owner}
			and (status = 'open' or (status = 'approved' and replayed_at is null))
		returning tool, contract, domain, level, arguments, correlation_id, origin`;
	const row = rows[0];
	return row === undefined
		? null
		: {
				tool: row.tool,
				contract: row.contract,
				domain: row.domain,
				level: row.level,
				arguments: readJsonColumn(row.arguments),
				correlationId: row.correlation_id,
				origin: row.origin
			};
}

// The call ran, and the conversation holds it
export async function markReplayed(tx: Tx, id: string): Promise<void> {
	await tx.sql`update pending_calls set replayed_at = now() where id = ${id}`;
}
