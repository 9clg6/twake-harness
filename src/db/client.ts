import postgres, { type Sql, type TransactionSql } from 'postgres';

import type { Principal } from '../principals/principal.js';

export interface Db {
	readonly sql: Sql;
	close(): Promise<void>;
}

export interface Tx {
	readonly sql: TransactionSql;
}

export function makeDb(databaseUrl: string): Db {
	const sql = postgres(databaseUrl, { max: 10, onnotice: () => undefined });
	return {
		sql,
		close: () => sql.end({ timeout: 5 })
	};
}

// Every access to user data goes through here: the transaction carries the principal, and the
// row-level security policies of each table filter on it. Outside such a transaction the policies
// see no principal and return nothing.
export async function withPrincipal<T>(
	db: Db,
	principal: Principal,
	run: (tx: Tx) => Promise<T>,
	options: { readonly admin?: boolean } = {}
): Promise<T> {
	return db.sql.begin(async (sql) => {
		await sql`select set_config('app.principal', ${principal.id}, true)`;
		if (options.admin === true) await sql`select set_config('app.admin', 'true', true)`;
		return run({ sql });
	}) as Promise<T>;
}

// Inside a transaction, the driver hands json columns back as text: read them the same way
// everywhere so that a row never changes shape with the query that fetched it.
export function readJsonColumn(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}
