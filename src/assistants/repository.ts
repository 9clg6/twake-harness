import type { FastifyBaseLogger } from 'fastify';

import type { Db, Tx } from '../db/client.js';
import { isLocale, type Locale } from '../i18n/messages.js';
import type { YesNoQuestion } from '../matrix/questions.js';

export interface AssistantRecord {
	readonly owner: string;
	readonly userId: string;
	readonly name: string;
	readonly roomId: string | null;
	// When it was created: one its owner deleted and created again has a time of its own, under the
	// same account
	readonly createdAt: Date;
	readonly deletedAt: Date | null;
	// The language its owner chose, null for the deployment's
	readonly locale: Locale | null;
}

interface AssistantRow {
	owner: string;
	user_id: string;
	name: string;
	room_id: string | null;
	created_at: Date;
	deleted_at: Date | null;
	locale: string | null;
}

function normalize(row: AssistantRow): AssistantRecord {
	return {
		owner: row.owner,
		userId: row.user_id,
		name: row.name,
		roomId: row.room_id,
		createdAt: row.created_at,
		deletedAt: row.deleted_at,
		// A language the harness no longer speaks falls back to the deployment's
		locale: row.locale !== null && isLocale(row.locale) ? row.locale : null
	};
}

export async function findAssistant(tx: Tx, owner: string): Promise<AssistantRecord | null> {
	const rows = await tx.sql<AssistantRow[]>`
		select owner, user_id, name, room_id, created_at, deleted_at, locale
		from assistants where owner = ${owner}`;
	const row = rows[0];
	return row === undefined ? null : normalize(row);
}

// Saves the owner's assistant, created now, in the row of the one they deleted if any, under a name
// the matrix role's start never renames. A deleted row of another principal may still name its
// Matrix account, as one an earlier build left under the owner's old principal: it is purged first,
// which the reclaim policies allow for that row only, while app.reclaim_user_id names the account.
export async function saveAssistant(
	tx: Tx,
	record: Omit<AssistantRecord, 'createdAt' | 'deletedAt' | 'locale'>
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
			created_at = now(),
			deleted_at = null,
			rename_if_former_default = false`;
	return { reclaimed: purged.count };
}

// The language the owner chose, kept with their assistant even once deleted, so that it holds if
// they create it again; false when they never had one
export async function setAssistantLocale(tx: Tx, owner: string, locale: Locale): Promise<boolean> {
	const result = await tx.sql`update assistants set locale = ${locale} where owner = ${owner}`;
	return result.count === 1;
}

// The room an assistant wrote its owner in, when it is this one, is no longer its room
export async function clearAssistantRoomId(tx: Tx, owner: string, roomId: string): Promise<void> {
	await tx.sql`update assistants set room_id = null where owner = ${owner} and room_id = ${roomId}`;
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

// The rooms the index names for the owner's assistant, each with the account it answers there as
export async function listAssistantRooms(
	db: Db | Tx,
	owner: string
): Promise<{ roomId: string; userId: string }[]> {
	const rows = await db.sql<{ room_id: string; user_id: string }[]>`
		select room_id, user_id from assistant_rooms where owner = ${owner}`;
	return rows.map((row) => ({ roomId: row.room_id, userId: row.user_id }));
}

// Whether the owner's live assistant still answers in the room, its record held until the
// transaction ends: its deletion, which locks that record first, waits for what the transaction
// keeps in its name, then erases it too
export async function holdAssistantInRoom(tx: Tx, owner: string, roomId: string): Promise<boolean> {
	const rows = await tx.sql`
		select 1 from assistants a
		where a.owner = ${owner} and a.deleted_at is null
			and exists (select 1 from assistant_rooms r where r.room_id = ${roomId} and r.owner = ${owner})
		for share of a`;
	return rows.length === 1;
}

// A name its owner gives the assistant settles it: the matrix role's start no longer renames it
export async function renameAssistant(tx: Tx, owner: string, name: string): Promise<boolean> {
	const result = await tx.sql`
		update assistants set name = ${name}, rename_if_former_default = false
		where owner = ${owner} and deleted_at is null`;
	return result.count === 1;
}

// Whether the owner's live assistant is flagged to take their first name at the matrix role's start,
// should it still go by a former default name
export async function isFlaggedToRenameIfFormerDefault(tx: Tx, owner: string): Promise<boolean> {
	const rows = await tx.sql<{ flagged: boolean }[]>`
		select rename_if_former_default as flagged
		from assistants where owner = ${owner} and deleted_at is null`;
	return rows[0]?.flagged === true;
}

// Settles the name of the owner's flagged assistant, which then goes unflagged: renamed only while
// it is flagged and still goes by one of the former names, so that a name given to it meanwhile
// stays. True when it was renamed.
export async function settleRenameIfFormerDefault(
	tx: Tx,
	owner: string,
	former: readonly string[],
	name: string
): Promise<boolean> {
	const renamed = await tx.sql`
		update assistants set name = ${name}
		where owner = ${owner} and deleted_at is null and rename_if_former_default
			and name in ${tx.sql([...former])} and name <> ${name}`;
	await tx.sql`update assistants set rename_if_former_default = false where owner = ${owner}`;
	return renamed.count === 1;
}

export async function markAssistantDeleted(tx: Tx, owner: string): Promise<boolean> {
	const result =
		await tx.sql`update assistants set deleted_at = now(), room_id = null where owner = ${owner} and deleted_at is null`;
	return result.count === 1;
}

// Where the creator conversation of an owner stands: waiting for the name of the assistant it
// creates, or for the owner's answer to the question that asks them to confirm the deletion of
// theirs, the one created at that time
export type DialogState =
	| { readonly step: 'awaiting_name' }
	| {
			readonly step: 'confirming_deletion';
			readonly question: YesNoQuestion;
			readonly assistantCreatedAt: Date;
	  };

interface DialogRow {
	state: string;
	question_id: string | null;
	expires_at: Date | null;
	assistant_created_at: Date | null;
}

export async function findDialog(
	tx: Tx,
	owner: string,
	log: FastifyBaseLogger
): Promise<DialogState | null> {
	const rows = await tx.sql<DialogRow[]>`
		select state, question_id, expires_at, assistant_created_at
		from creator_dialogs where owner = ${owner}`;
	const row = rows[0];
	if (row === undefined) return null;
	if (row.state === 'awaiting_name') return { step: 'awaiting_name' };
	if (
		row.state === 'confirming_deletion' &&
		row.question_id !== null &&
		row.expires_at !== null &&
		row.assistant_created_at !== null
	) {
		const question = { id: row.question_id, expiresTs: row.expires_at.getTime() };
		return {
			step: 'confirming_deletion',
			question,
			assistantCreatedAt: row.assistant_created_at
		};
	}
	// A step this build does not know, as a later one may write, leaves the dialog where it starts
	log.warn({ owner, state: row.state }, 'creator dialog unreadable');
	return null;
}

export async function saveDialog(tx: Tx, owner: string, state: DialogState | null): Promise<void> {
	if (state === null) {
		await tx.sql`delete from creator_dialogs where owner = ${owner}`;
		return;
	}
	const confirming = state.step === 'confirming_deletion' ? state : null;
	await tx.sql`
		insert into creator_dialogs (owner, state, question_id, expires_at, assistant_created_at)
		values (
			${owner},
			${state.step},
			${confirming?.question.id ?? null},
			${confirming === null ? null : new Date(confirming.question.expiresTs)},
			${confirming?.assistantCreatedAt ?? null}
		)
		on conflict (owner) do update set
			state = excluded.state,
			question_id = excluded.question_id,
			expires_at = excluded.expires_at,
			assistant_created_at = excluded.assistant_created_at,
			updated_at = now()`;
}

// Takes the answer to the question the owner's dialog waits on, which leaves the dialog where it
// starts: true for the one message that took it
export async function claimDialogQuestion(
	tx: Tx,
	owner: string,
	questionId: string
): Promise<boolean> {
	const claimed = await tx.sql`
		delete from creator_dialogs
		where owner = ${owner} and state = 'confirming_deletion' and question_id = ${questionId}`;
	return claimed.count === 1;
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

// The rooms of an assistant with its owner, from the rooms index
export async function listAssistantRoomIds(
	db: Db,
	owner: string,
	userId: string
): Promise<string[]> {
	const rows = await db.sql<{ room_id: string }[]>`
		select room_id from assistant_rooms where owner = ${owner} and user_id = ${userId}`;
	return rows.map((row) => row.room_id);
}

// An assistant a provisioner asked for, in an index without user content: the matrix role
// prepares it at its start even before it has a room. An assistant the provisioner made owes its
// owner the greeting until it gives it; one that already existed owes no more than it did.
export async function saveProvisioned(
	db: Db | Tx,
	provisioned: { readonly owner: string; readonly userId: string; readonly owesWelcome: boolean }
): Promise<void> {
	const { owner, userId, owesWelcome } = provisioned;
	await db.sql`
		insert into assistant_provisioned (owner, user_id, owes_welcome)
		values (${owner}, ${userId}, ${owesWelcome})
		on conflict (owner) do update set
			user_id = excluded.user_id,
			owes_welcome = assistant_provisioned.owes_welcome or excluded.owes_welcome`;
}

// Takes the greeting a provisioned assistant owes its owner: true for the one call that took it
export async function claimProvisionedWelcome(
	tx: Tx,
	owner: string,
	userId: string
): Promise<boolean> {
	const claimed = await tx.sql`
		update assistant_provisioned set owes_welcome = false
		where owner = ${owner} and user_id = ${userId} and owes_welcome`;
	return claimed.count === 1;
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
