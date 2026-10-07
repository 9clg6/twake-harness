import type { Tx } from '../db/client.js';

// How the harness came to hold an owner's identity: the first one it saw published, or the one the
// owner accepted through the API
export type PinnedBy = 'first_use' | 'api';

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
		pinnedBy: row.pinned_by === 'api' ? 'api' : 'first_use',
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

// The identity the owner accepted through the API replaces the one the harness held
export async function pinAccepted(
	tx: Tx,
	owner: string,
	masterPublicKey: string
): Promise<OwnerCrossSigning> {
	const rows = await tx.sql<OwnerCrossSigningRow[]>`
		insert into owner_cross_signing (owner, master_public_key, pinned_by)
		values (${owner}, ${masterPublicKey}, 'api')
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
