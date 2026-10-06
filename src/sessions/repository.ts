import { randomUUID } from 'node:crypto';

import { readJsonColumn, type Tx } from '../db/client.js';
import type { LlmMessage } from '../llm/client.js';

export interface SessionRecord {
	readonly id: string;
	readonly owner: string;
	readonly messages: readonly LlmMessage[];
}

interface SessionRow {
	id: string;
	owner: string;
	messages: unknown;
}

export function makeSessionId(): string {
	return randomUUID().replaceAll('-', '');
}

function normalizeSessionRow(row: SessionRow): SessionRecord {
	const messages = readJsonColumn(row.messages);
	return {
		id: row.id,
		owner: row.owner,
		messages: Array.isArray(messages) ? (messages as LlmMessage[]) : []
	};
}

export async function createSession(tx: Tx, owner: string): Promise<SessionRecord> {
	const id = makeSessionId();
	await tx.sql`insert into sessions (id, owner) values (${id}, ${owner})`;
	return { id, owner, messages: [] };
}

// Row-level security hides other owners' sessions: a foreign id is simply not found.
export async function findSession(tx: Tx, id: string): Promise<SessionRecord | null> {
	const rows = await tx.sql<
		SessionRow[]
	>`select id, owner, messages from sessions where id = ${id}`;
	const row = rows[0];
	return row === undefined ? null : normalizeSessionRow(row);
}

export async function saveSessionMessages(
	tx: Tx,
	id: string,
	messages: readonly LlmMessage[]
): Promise<boolean> {
	const result = await tx.sql`
		update sessions set messages = ${JSON.stringify(messages)}::jsonb, updated_at = now()
		where id = ${id}`;
	return result.count === 1;
}

export async function listSessionIds(tx: Tx): Promise<string[]> {
	const rows = await tx.sql<{ id: string }[]>`select id from sessions order by updated_at desc`;
	return rows.map((row) => row.id);
}

// The conversation of an owner with their assistant in one room is one session, created on
// the first message.
export async function ensureRoomSession(
	tx: Tx,
	owner: string,
	roomId: string
): Promise<SessionRecord> {
	const rows = await tx.sql<SessionRow[]>`
		select id, owner, messages from sessions where owner = ${owner} and room_id = ${roomId}`;
	const row = rows[0];
	if (row !== undefined) return normalizeSessionRow(row);
	const id = makeSessionId();
	await tx.sql`insert into sessions (id, owner, room_id) values (${id}, ${owner}, ${roomId})`;
	return { id, owner, messages: [] };
}

export interface SessionMatch {
	readonly id: string;
	readonly updatedAt: Date;
	readonly snippet: string;
}

interface MatchRow {
	id: string;
	updated_at: Date;
	messages: unknown;
}

// Words of past conversations of the owner, the newest first; the policy keeps it to theirs
export async function searchSessions(tx: Tx, query: string, limit = 10): Promise<SessionMatch[]> {
	const pattern = `%${query.toLowerCase()}%`;
	const rows = await tx.sql<MatchRow[]>`
		select id, updated_at, messages from sessions
		where lower(messages::text) like ${pattern}
		order by updated_at desc limit ${limit}`;
	return rows.map((row) => {
		const messages = readJsonColumn(row.messages);
		const texts = Array.isArray(messages)
			? (messages as LlmMessage[]).map((m) => (typeof m.content === 'string' ? m.content : ''))
			: [];
		const hit = texts.find((t) => t.toLowerCase().includes(query.toLowerCase())) ?? '';
		return { id: row.id, updatedAt: row.updated_at, snippet: hit.slice(0, 200) };
	});
}
