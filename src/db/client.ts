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
	run: (tx: Tx) => Promise<T>
): Promise<T> {
	return db.sql.begin(async (sql) => {
		await sql`select set_config('app.principal', ${principal.id}, true)`;
		return run({ sql });
	}) as Promise<T>;
}
