import { readJsonColumn, type Tx } from '../db/client.js';
import type { Principal } from './principal.js';

export const DEFAULT_ACTIONS: readonly string[] = [
	'chat',
	'sessions.read_own',
	'skills.read_own',
	'memory.read_own',
	'memory.write_own',
	'contracts.call',
	'contracts.act',
	'settings.write_own'
];

export interface PrincipalRecord {
	readonly id: string;
	readonly actions: readonly string[];
}

interface PrincipalRow {
	id: string;
	actions: unknown;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function normalizePrincipalRow(row: PrincipalRow): PrincipalRecord {
	const actions = readJsonColumn(row.actions);
	return { id: row.id, actions: isStringArray(actions) ? actions : [] };
}

// Idempotent: the first request of a subject creates it with the default rights, later requests
// find the stored rights, customized or revoked ones included.
export async function ensurePrincipal(tx: Tx, principal: Principal): Promise<PrincipalRecord> {
	await tx.sql`
		insert into principals (id, actions)
		values (${principal.id}, ${tx.sql.json([...DEFAULT_ACTIONS])})
		on conflict (id) do nothing`;
	await tx.sql`insert into principal_index (owner) values (${principal.id}) on conflict do nothing`;
	const rows = await tx.sql<PrincipalRow[]>`
		select id, actions from principals where id = ${principal.id}`;
	const row = rows[0];
	if (row === undefined) {
		throw new Error(`principal ${principal.id} is not visible to its own transaction`);
	}
	return normalizePrincipalRow(row);
}
