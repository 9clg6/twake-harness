import type { Answer } from '../consents/answers.js';
import type { Tx } from '../db/client.js';
import type { YesNoQuestion } from './questions.js';

// How the harness came to hold an owner's identity: the first one it saw published, the one the
// owner accepted through the API, or the one they said yes to when their assistant asked them
export type PinnedBy = 'first_use' | 'api' | 'chat';

// How the owner accepted the identity the harness holds for them
export type AcceptedBy = Exclude<PinnedBy, 'first_use'>;

// Every way an identity may be held, so that one read back is known for one: a way added to
// PinnedBy and missing here fails the build
const PINNED_BY: Readonly<Record<PinnedBy, true>> = {
	first_use: true,
	api: true,
	chat: true
};

function isPinnedBy(value: string): value is PinnedBy {
	return Object.hasOwn(PINNED_BY, value);
}

// The identity that signed the session the owner's words last came from, when it was another one
// than the one held, and when
export interface SeenIdentity {
	readonly masterPublicKey: string;
	readonly at: Date;
}

export interface OwnerCrossSigning {
	readonly owner: string;
	readonly masterPublicKey: string;
	readonly pinnedBy: PinnedBy;
	readonly pinnedAt: Date;
	readonly seen: SeenIdentity | null;
}

// Why the owner is told about one of their devices
export type DeviceNoticeReason =
	| 'unverified'
	| 'no_identity'
	| 'identity_changed'
	| 'check_failed'
	| 'unencrypted'
	| 'old_session';

interface OwnerCrossSigningRow {
	owner: string;
	master_public_key: string;
	pinned_by: string;
	pinned_at: Date;
	seen_master_public_key: string | null;
	seen_at: Date | null;
}

function normalize(row: OwnerCrossSigningRow): OwnerCrossSigning {
	return {
		owner: row.owner,
		masterPublicKey: row.master_public_key,
		pinnedBy: isPinnedBy(row.pinned_by) ? row.pinned_by : 'first_use',
		pinnedAt: row.pinned_at,
		seen:
			row.seen_master_public_key === null || row.seen_at === null
				? null
				: { masterPublicKey: row.seen_master_public_key, at: row.seen_at }
	};
}

export async function findOwnerCrossSigning(
	tx: Tx,
	owner: string
): Promise<OwnerCrossSigning | null> {
	const rows = await tx.sql<OwnerCrossSigningRow[]>`
		select owner, master_public_key, pinned_by, pinned_at, seen_master_public_key, seen_at
		from owner_cross_signing where owner = ${owner}`;
	const row = rows[0];
	return row === undefined ? null : normalize(row);
}

// Holds the identity the harness sees for the first time for this owner, and leaves one it holds
// already as it is: resolves to the identity it holds once done, and whether it was this one
export async function pinFirstSeen(
	tx: Tx,
	owner: string,
	masterPublicKey: string
): Promise<OwnerCrossSigning & { readonly pinnedNow: boolean }> {
	const inserted = await tx.sql`
		insert into owner_cross_signing (owner, master_public_key, pinned_by)
		values (${owner}, ${masterPublicKey}, 'first_use')
		on conflict (owner) do nothing
		returning 1`;
	const held = await findOwnerCrossSigning(tx, owner);
	if (held === null) throw new Error('the identity just pinned is not stored');
	return { ...held, pinnedNow: inserted.length === 1 };
}

// The owner's words came from a session that another identity than the one held signed
export async function recordSeen(tx: Tx, owner: string, masterPublicKey: string): Promise<void> {
	await tx.sql`
		update owner_cross_signing
		set seen_master_public_key = ${masterPublicKey}, seen_at = now()
		where owner = ${owner}`;
}

// The owner's words came with the identity held again
export async function clearSeen(tx: Tx, owner: string): Promise<void> {
	await tx.sql`
		update owner_cross_signing set seen_master_public_key = null, seen_at = null
		where owner = ${owner} and seen_at is not null`;
}

// The identity the owner accepted replaces the one the harness held
async function pinAccepted(
	tx: Tx,
	owner: string,
	masterPublicKey: string,
	by: AcceptedBy
): Promise<OwnerCrossSigning> {
	const rows = await tx.sql<OwnerCrossSigningRow[]>`
		insert into owner_cross_signing (owner, master_public_key, pinned_by)
		values (${owner}, ${masterPublicKey}, ${by})
		on conflict (owner) do update set
			master_public_key = excluded.master_public_key,
			pinned_by = excluded.pinned_by,
			pinned_at = now(),
			seen_master_public_key = null,
			seen_at = null
		returning owner, master_public_key, pinned_by, pinned_at, seen_master_public_key, seen_at`;
	const row = rows[0];
	if (row === undefined) throw new Error('the accepted identity is not stored');
	return normalize(row);
}

// The owner accepts the identity that signed the session their words last came from, in place of
// the one the harness held: only while it is still the latest one seen. Resolves to the identity
// held before, and to the one held now, null when it was not the identity seen.
export async function acceptSeenIdentity(
	tx: Tx,
	owner: string,
	masterPublicKey: string,
	by: AcceptedBy
): Promise<{
	readonly held: OwnerCrossSigning | null;
	readonly pinned: OwnerCrossSigning | null;
}> {
	const held = await findOwnerCrossSigning(tx, owner);
	if (held?.seen?.masterPublicKey !== masterPublicKey) return { held, pinned: null };
	return { held, pinned: await pinAccepted(tx, owner, masterPublicKey, by) };
}

interface IdentityQuestionRow {
	question_id: string;
	question_expires_at: Date;
}

// The question that asks the owner whether they reset their identity themselves, as their client
// tells it from other messages: its id, and until when it waits for their answer
function toYesNoQuestion(row: IdentityQuestionRow): YesNoQuestion {
	return { id: row.question_id, expiresTs: row.question_expires_at.getTime() };
}

// Asks the owner, in the room their words came to, whether they reset their identity themselves:
// about the identity seen for them, waiting for their answer for `lifetimeMs` from now, an end
// stored as its mark tells it to their client before it goes out. Unless a question about that
// identity waits for their answer still, or they answered it already: resolves to the question to
// ask then, and to null otherwise. It counts as asked once it reached the room.
export async function askIdentityQuestion(
	tx: Tx,
	owner: string,
	asked: {
		readonly masterPublicKey: string;
		readonly roomId: string;
		readonly raisedBy: string;
		readonly lifetimeMs: number;
	}
): Promise<YesNoQuestion | null> {
	const { masterPublicKey, roomId, raisedBy, lifetimeMs } = asked;
	const rows = await tx.sql<IdentityQuestionRow[]>`
		update owner_cross_signing set
			question_id = gen_random_uuid(),
			question_master_public_key = ${masterPublicKey},
			question_room_id = ${roomId},
			question_raised_by = ${raisedBy},
			question_expires_at = now() + make_interval(secs => ${lifetimeMs / 1000}),
			question_event_id = null,
			question_asked_at = null,
			question_closed_at = null,
			question_answer = null,
			question_answer_event_id = null
		where owner = ${owner}
			and seen_master_public_key = ${masterPublicKey}
			and (
				question_id is null
				or question_master_public_key <> ${masterPublicKey}
				or (question_answer is null and question_expires_at <= now())
			)
		returning question_id, question_expires_at`;
	const row = rows[0];
	return row === undefined ? null : toYesNoQuestion(row);
}

// The question about their identity reached the owner's room in this event: from then on it is
// asked, and their next words may answer it. False when another question replaced it meanwhile.
export async function recordIdentityQuestionEvent(
	tx: Tx,
	owner: string,
	questionId: string,
	eventId: string
): Promise<boolean> {
	const result = await tx.sql`
		update owner_cross_signing set question_event_id = ${eventId}, question_asked_at = now()
		where owner = ${owner} and question_id = ${questionId}`;
	return result.count === 1;
}

// The question about their identity open to the owner's words: asked in the room, about the
// identity seen for them still, neither answered nor closed to words, and not expired
export interface OpenIdentityQuestion {
	readonly id: string;
	readonly masterPublicKey: string;
	// When it reached the room
	readonly askedAt: Date;
}

// The owner wrote in the room: the question about their identity asked there is no longer open to
// an answer in words, unless these are the words that raised it, or it had yet to reach the room.
// Resolves to the question that was open to them, null when none was.
export async function closeIdentityQuestion(
	tx: Tx,
	owner: string,
	roomId: string,
	eventId: string
): Promise<OpenIdentityQuestion | null> {
	const rows = await tx.sql<
		{ question_id: string; question_master_public_key: string; question_asked_at: Date }[]
	>`
		update owner_cross_signing set question_closed_at = now()
		where owner = ${owner} and question_room_id = ${roomId} and question_asked_at is not null
			and question_raised_by <> ${eventId}
			and question_closed_at is null and question_answer is null and question_expires_at > now()
			and question_master_public_key = seen_master_public_key
		returning question_id, question_master_public_key, question_asked_at`;
	const row = rows[0];
	return row === undefined
		? null
		: {
				id: row.question_id,
				masterPublicKey: row.question_master_public_key,
				askedAt: row.question_asked_at
			};
}

// The owner's answer to the question about their identity, and the event that carries it
export async function recordIdentityAnswer(
	tx: Tx,
	owner: string,
	questionId: string,
	says: Answer,
	eventId: string
): Promise<void> {
	await tx.sql`
		update owner_cross_signing
		set question_answer = ${says}, question_answer_event_id = ${eventId}
		where owner = ${owner} and question_id = ${questionId}`;
}

// Whether this event of the owner already answered the question about their identity, as an event
// delivered again would have
export async function isIdentityAnswerEvent(
	tx: Tx,
	owner: string,
	eventId: string
): Promise<boolean> {
	const rows = await tx.sql`
		select 1 from owner_cross_signing where owner = ${owner} and question_answer_event_id = ${eventId}`;
	return rows.length > 0;
}

// Records when the check first decrypted words of an owner's Megolm session. Resolves to whether
// that was longer ago than `keptMs`, the time the digests of those words are kept for.
export async function seeSession(
	tx: Tx,
	owner: string,
	sessionId: string,
	keptMs: number
): Promise<boolean> {
	await tx.sql`
		insert into owner_megolm_sessions (owner, session_id) values (${owner}, ${sessionId})
		on conflict (owner, session_id) do nothing`;
	const rows = await tx.sql<{ old: boolean }[]>`
		select first_seen_at <= now() - make_interval(secs => ${keptMs / 1000}) as old
		from owner_megolm_sessions where owner = ${owner} and session_id = ${sessionId}`;
	return rows[0]?.old ?? false;
}

// Records that the owner's words with this digest were received under an event, the words received
// longer ago than `keptMs` forgotten first. Resolves to the event they were first received under
// when it is another one, and to null for words new to the harness or delivered again under the
// same event.
export async function receiveWords(
	tx: Tx,
	owner: string,
	digest: string,
	eventId: string,
	keptMs: number
): Promise<string | null> {
	await tx.sql`
		delete from owner_words_received
		where owner = ${owner} and received_at <= now() - make_interval(secs => ${keptMs / 1000})`;
	const inserted = await tx.sql`
		insert into owner_words_received (owner, digest, event_id)
		values (${owner}, ${digest}, ${eventId})
		on conflict (owner, digest) do nothing
		returning 1`;
	if (inserted.length === 1) return null;
	const rows = await tx.sql<{ event_id: string }[]>`
		select event_id from owner_words_received where owner = ${owner} and digest = ${digest}`;
	const first = rows[0]?.event_id ?? null;
	return first === eventId ? null : first;
}

// Whether the owner is to be told about a device now: once for good when `againAfterMs` is null,
// or again once that long has passed since they were last told. Resolves to true for the one
// caller that is to tell them.
export async function claimDeviceNotice(
	tx: Tx,
	owner: string,
	device: string,
	reason: DeviceNoticeReason,
	againAfterMs: number | null
): Promise<boolean> {
	const rows =
		againAfterMs === null
			? await tx.sql`
				insert into owner_device_notices (owner, device, reason)
				values (${owner}, ${device}, ${reason})
				on conflict (owner, device, reason) do nothing
				returning 1`
			: await tx.sql`
				insert into owner_device_notices (owner, device, reason)
				values (${owner}, ${device}, ${reason})
				on conflict (owner, device, reason) do update set notified_at = now()
				where owner_device_notices.notified_at
					<= now() - make_interval(secs => ${againAfterMs / 1000})
				returning 1`;
	return rows.length === 1;
}
