import type { Db, Tx } from '../db/client.js';

export interface AssistantRecord {
	readonly owner: string;
	readonly userId: string;
	readonly name: string;
	readonly roomId: string | null;
	readonly deletedAt: Date | null;
}

interface AssistantRow {
	owner: string;
	user_id: string;
	name: string;
	room_id: string | null;
	deleted_at: Date | null;
}

function normalize(row: AssistantRow): AssistantRecord {
	return {
		owner: row.owner,
		userId: row.user_id,
		name: row.name,
		roomId: row.room_id,
		deletedAt: row.deleted_at
	};
}

export async function findAssistant(tx: Tx, owner: string): Promise<AssistantRecord | null> {
	const rows = await tx.sql<AssistantRow[]>`
		select owner, user_id, name, room_id, deleted_at
		from assistants where owner = ${owner}`;
	const row = rows[0];
	return row === undefined ? null : normalize(row);
}

export async function saveAssistant(
	tx: Tx,
	record: Omit<AssistantRecord, 'deletedAt'>
): Promise<void> {
	await tx.sql`
		insert into assistants (owner, user_id, name, room_id)
		values (${record.owner}, ${record.userId}, ${record.name}, ${record.roomId})
		on conflict (owner) do update set
			user_id = excluded.user_id,
			name = excluded.name,
			room_id = excluded.room_id,
			deleted_at = null`;
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
