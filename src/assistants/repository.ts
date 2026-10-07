import type { Db, Tx } from '../db/client.js';
import { isLocale, type Locale } from '../i18n/messages.js';

export interface AssistantRecord {
	readonly owner: string;
	readonly userId: string;
	readonly name: string;
	readonly roomId: string | null;
	readonly deletedAt: Date | null;
	// The language its owner chose, null for the deployment's
	readonly locale: Locale | null;
}

interface AssistantRow {
	owner: string;
	user_id: string;
	name: string;
	room_id: string | null;
	deleted_at: Date | null;
	locale: string | null;
}

function normalize(row: AssistantRow): AssistantRecord {
	return {
		owner: row.owner,
		userId: row.user_id,
		name: row.name,
		roomId: row.room_id,
		deletedAt: row.deleted_at,
		// A language the harness no longer speaks falls back to the deployment's
		locale: row.locale !== null && isLocale(row.locale) ? row.locale : null
	};
}

export async function findAssistant(tx: Tx, owner: string): Promise<AssistantRecord | null> {
	const rows = await tx.sql<AssistantRow[]>`
		select owner, user_id, name, room_id, deleted_at, locale
		from assistants where owner = ${owner}`;
	const row = rows[0];
	return row === undefined ? null : normalize(row);
}

// Saves the owner's assistant. A deleted row of another principal may still name its Matrix
// account, as one an earlier build left under the owner's old principal: it is purged first, which
// the reclaim policies allow for that row only, while app.reclaim_user_id names the account.
export async function saveAssistant(
	tx: Tx,
	record: Omit<AssistantRecord, 'deletedAt' | 'locale'>
): Promise<{ readonly reclaimed: number }> {
	await tx.sql`select set_config('app.reclaim_user_id', ${record.userId}, true)`;
	const purged = await tx.sql`
		delete from assistants
		where user_id = ${record.userId} and deleted_at is not null and owner <> ${record.owner}`;
	await tx.sql`select set_config('app.reclaim_user_id', '', true)`;
	await tx.sql`
		insert into assistants (owner, user_id, name, room_id)
		values (${record.owner}, ${record.userId}, ${record.name}, ${record.roomId})
		on conflict (owner) do update set
			user_id = excluded.user_id,
			name = excluded.name,
			room_id = excluded.room_id,
			deleted_at = null`;
	return { reclaimed: purged.count };
}

// The language the owner chose, kept with their assistant even once deleted, so that it holds if
// they create it again; false when they never had one
export async function setAssistantLocale(tx: Tx, owner: string, locale: Locale): Promise<boolean> {
	const result = await tx.sql`update assistants set locale = ${locale} where owner = ${owner}`;
	return result.count === 1;
}

export async function setAssistantRoomId(tx: Tx, owner: string, roomId: string): Promise<void> {
	await tx.sql`update assistants set room_id = ${roomId} where owner = ${owner} and deleted_at is null`;
}

// The index the matrix role routes the rooms by, with the greeting the assistant still owes
export async function saveAssistantRoom(
	tx: Tx,
	room: {
		readonly roomId: string;
		readonly owner: string;
		readonly userId: string;
		readonly welcome: string;
	}
): Promise<void> {
	await tx.sql`
		insert into assistant_rooms (room_id, owner, user_id, welcome)
		values (${room.roomId}, ${room.owner}, ${room.userId}, ${room.welcome})
		on conflict (room_id) do update set
			owner = excluded.owner, user_id = excluded.user_id, welcome = excluded.welcome`;
}

export async function renameAssistant(tx: Tx, owner: string, name: string): Promise<boolean> {
	const result =
		await tx.sql`update assistants set name = ${name} where owner = ${owner} and deleted_at is null`;
	return result.count === 1;
}

export async function markAssistantDeleted(tx: Tx, owner: string): Promise<boolean> {
	const result =
		await tx.sql`update assistants set deleted_at = now(), room_id = null where owner = ${owner} and deleted_at is null`;
	return result.count === 1;
}

export type DialogState = 'awaiting_name';

export async function findDialog(tx: Tx, owner: string): Promise<DialogState | null> {
	const rows = await tx.sql<
		{ state: string }[]
	>`select state from creator_dialogs where owner = ${owner}`;
	const state = rows[0]?.state;
	return state === 'awaiting_name' ? state : null;
}

export async function saveDialog(tx: Tx, owner: string, state: DialogState | null): Promise<void> {
	if (state === null) {
		await tx.sql`delete from creator_dialogs where owner = ${owner}`;
		return;
	}
	await tx.sql`
		insert into creator_dialogs (owner, state) values (${owner}, ${state})
		on conflict (owner) do update set state = excluded.state, updated_at = now()`;
}

// The identifiers of every live assistant, from the room index that carries no user content
export async function listActiveAssistantUserIds(db: Db): Promise<string[]> {
	const rows = await db.sql<{ user_id: string }[]>`select distinct user_id from assistant_rooms`;
	return rows.map((row) => row.user_id);
}

// From the rooms index, which has no owner policy: the assistants table is read by its owner only
export async function listActiveAssistants(db: Db): Promise<{ owner: string; userId: string }[]> {
	const rows = await db.sql<{ owner: string; user_id: string }[]>`
		select distinct owner, user_id from assistant_rooms`;
	return rows.map((row) => ({ owner: row.owner, userId: row.user_id }));
}

// An assistant a provisioner asked for, in an index without user content: the matrix role
// prepares it at its start even before it has a room
export async function saveProvisioned(db: Db, owner: string, userId: string): Promise<void> {
	await db.sql`
		insert into assistant_provisioned (owner, user_id) values (${owner}, ${userId})
		on conflict (owner) do update set user_id = excluded.user_id`;
}

// The provisioned assistants that have no room yet, which the rooms index does not list
export async function listProvisionedWithoutRoom(
	db: Db
): Promise<{ owner: string; userId: string }[]> {
	const rows = await db.sql<{ owner: string; user_id: string }[]>`
		select p.owner, p.user_id from assistant_provisioned p
		where not exists (select 1 from assistant_rooms r where r.owner = p.owner)`;
	return rows.map((row) => ({ owner: row.owner, userId: row.user_id }));
}
