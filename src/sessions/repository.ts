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
