import { isStringArray, readJsonColumn, type Tx } from '../db/client.js';
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

// The Matrix event and room of the question asked about a call, which its owner's answer points
// to; false when no such call is stored, so that no answer could ever find it
export async function recordRequestEvent(
	tx: Tx,
	id: string,
	eventId: string,
	roomId: string
): Promise<boolean> {
	const result = await tx.sql`
		update pending_calls set request_event_id = ${eventId}, room_id = ${roomId} where id = ${id}`;
	return result.count === 1;
}

// What a waiting call is about: its application, its level and the reasons it waits for. Its
// metrics count it by these, never by its owner nor what it would send.
export interface CallSubject {
	readonly domain: string;
	readonly level: ConsentLevel;
	readonly reasons: readonly WaitReason[];
}

interface SubjectRow {
	domain: string;
	level: ConsentLevel;
	reasons: unknown;
}

// Every reason a call may wait for, so that a reason read back is known for one: a reason added
// to WaitReason and missing here fails the build
const WAIT_REASONS: Readonly<Record<WaitReason, true>> = { consent: true };

function isWaitReason(value: string): value is WaitReason {
	return Object.hasOwn(WAIT_REASONS, value);
}

function subjectOf(row: SubjectRow): CallSubject {
	const reasons = readJsonColumn(row.reasons);
	return {
		domain: row.domain,
		level: row.level,
		reasons: isStringArray(reasons) ? reasons.filter(isWaitReason) : []
	};
}

// A request closed unanswered, and what its call was about
export interface ClosedRequest extends CallSubject {
	readonly pendingCallId: string;
}

interface ClosedRow extends SubjectRow {
	id: string;
}

function closedRequests(rows: readonly ClosedRow[]): ClosedRequest[] {
	return rows.map((row) => ({ pendingCallId: row.id, ...subjectOf(row) }));
}

// Marks the open requests of a room older than the one just asked as superseded, erasing what
// their calls would have sent
export async function supersedeRequests(
	tx: Tx,
	owner: string,
	roomId: string,
	newestId: string
): Promise<ClosedRequest[]> {
	const rows = await tx.sql<ClosedRow[]>`
		update pending_calls set status = 'superseded', decided_at = now(), arguments = null
		where owner = ${owner} and room_id = ${roomId} and status = 'open' and id <> ${newestId}
		returning id, domain, level, reasons`;
	return closedRequests(rows);
}

// Closes the owner's requests left unanswered past their lifetime, erasing what their calls would
// have sent
export async function expireRequests(
	tx: Tx,
	owner: string,
	lifetimeMs: number
): Promise<ClosedRequest[]> {
	const rows = await tx.sql<ClosedRow[]>`
		update pending_calls set status = 'expired', decided_at = now(), arguments = null
		where owner = ${owner} and status = 'open'
			and created_at <= now() - make_interval(secs => ${lifetimeMs / 1000})
		returning id, domain, level, reasons`;
	return closedRequests(rows);
}

// What an answer finds: a request still open, one closed unanswered (its lifetime over, or a
// newer one asked in its room), or one already decided
export type RequestState = 'open' | 'expired' | 'superseded' | 'decided';

export interface FoundRequest extends CallSubject {
	readonly pendingCallId: string;
	readonly state: RequestState;
}

interface RequestRow extends SubjectRow {
	id: string;
	status: string;
}

function foundRequest(row: RequestRow | undefined): FoundRequest | null {
	if (row === undefined) return null;
	const state =
		row.status === 'open' || row.status === 'expired' || row.status === 'superseded'
			? row.status
			: 'decided';
	return { pendingCallId: row.id, state, ...subjectOf(row) };
}

// The request asked in this event, whatever became of it
export async function findRequest(
	tx: Tx,
	owner: string,
	requestEventId: string
): Promise<FoundRequest | null> {
	const rows = await tx.sql<RequestRow[]>`
		select id, status, domain, level, reasons from pending_calls
		where owner = ${owner} and request_event_id = ${requestEventId}`;
	return foundRequest(rows[0]);
}

// The latest request of a room still open to an answer in words, its owner having written nothing
// else since it was asked. One that expired is found too, so that its answer gets the notice.
export async function findRequestOpenToWords(
	tx: Tx,
	owner: string,
	roomId: string
): Promise<FoundRequest | null> {
	const rows = await tx.sql<RequestRow[]>`
		select id, status, domain, level, reasons from pending_calls
		where owner = ${owner} and room_id = ${roomId} and status in ('open', 'expired')
			and words_closed_at is null
		order by created_at desc
		limit 1`;
	return foundRequest(rows[0]);
}

// The owner wrote in the room: its requests are no longer open to an answer in words
export async function closeRequestsToWords(tx: Tx, owner: string, roomId: string): Promise<void> {
	await tx.sql`
		update pending_calls set words_closed_at = now()
		where owner = ${owner} and room_id = ${roomId} and words_closed_at is null`;
}

// Whether this event of the owner already answered one of their requests, as an event delivered
// again would have
export async function isAnswerEvent(tx: Tx, owner: string, eventId: string): Promise<boolean> {
	const rows = await tx.sql`
		select 1 from pending_calls where owner = ${owner} and answer_event_id = ${eventId}`;
	return rows.length > 0;
}

// The owner's answer to a call still waiting, once: a yes approves it, for its resume job to run,
// and a no refuses it, erasing what it would have sent. From then on no other answer, nor a newer
// request, changes it. A yes also lands on a call its resume job approved first, so that the
// answer is recorded. False when the call was no longer waiting.
export async function decidePendingCall(
	tx: Tx,
	owner: string,
	id: string,
	decision: 'approved' | 'refused',
	answerEventId: string
): Promise<boolean> {
	const result = await tx.sql`
		update pending_calls set status = ${decision}, decided_at = coalesce(decided_at, now()),
			answer_event_id = ${answerEventId},
			arguments = case when ${decision} = 'refused' then null else arguments end
		where id = ${id} and owner = ${owner}
			and (status = 'open' or (status = ${decision} and answer_event_id is null))`;
	return result.count === 1;
}

// The event by which the owner answered a request already closed, kept so that, delivered again,
// it is not taken for a message. Only the first answer is kept: false for any later one.
export async function recordAnswerEvent(
	tx: Tx,
	owner: string,
	id: string,
	eventId: string
): Promise<boolean> {
	const result = await tx.sql`
		update pending_calls set answer_event_id = ${eventId}
		where id = ${id} and owner = ${owner} and answer_event_id is null`;
	return result.count === 1;
}

export interface ApprovedCall extends CallSubject {
	readonly tool: string;
	readonly contract: string;
	readonly arguments: unknown;
	readonly correlationId: string | null;
	readonly origin: TurnOrigin;
}

interface ApprovedRow extends SubjectRow {
	tool: string;
	contract: string;
	arguments: unknown;
	correlation_id: string | null;
	origin: TurnOrigin;
}

// Hands out a call its owner allowed, for its resume job to run it: approved when the answer
// came, or still waiting if the job came first. A call approved but never run, its job having
// died, is handed out again; one already run, or decided otherwise, is not.
export async function approvePendingCall(
	tx: Tx,
	owner: string,
	id: string
): Promise<ApprovedCall | null> {
	const rows = await tx.sql<ApprovedRow[]>`
		update pending_calls set status = 'approved', decided_at = coalesce(decided_at, now())
		where id = ${id} and owner = ${owner}
			and (status = 'open' or (status = 'approved' and replayed_at is null))
		returning tool, contract, domain, level, reasons, arguments, correlation_id, origin`;
	const row = rows[0];
	return row === undefined
		? null
		: {
				...subjectOf(row),
				tool: row.tool,
				contract: row.contract,
				arguments: readJsonColumn(row.arguments),
				correlationId: row.correlation_id,
				origin: row.origin
			};
}

// The call ran, and the conversation holds it: what it sent is erased
export async function markReplayed(tx: Tx, id: string): Promise<void> {
	await tx.sql`update pending_calls set replayed_at = now(), arguments = null where id = ${id}`;
}
