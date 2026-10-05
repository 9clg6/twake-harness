import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Db } from './client.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export interface MigrationReport {
	readonly applied: readonly string[];
}

async function listMigrationFiles(): Promise<string[]> {
	const entries = await readdir(MIGRATIONS_DIR);
	return entries.filter((name) => name.endsWith('.sql')).sort();
}

export async function runMigrations(db: Db): Promise<MigrationReport> {
	await db.sql.unsafe(
		'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())'
	);
	const applied: string[] = [];
	// A lock keeps two replicas from applying the same migration at the same time.
	await db.sql.begin(async (sql) => {
		await sql`select pg_advisory_xact_lock(727001)`;
		const done = new Set(
			(await sql<{ name: string }[]>`select name from schema_migrations`).map((row) => row.name)
		);
		for (const name of await listMigrationFiles()) {
			if (done.has(name)) continue;
			const statements = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
			await sql.unsafe(statements);
			await sql`insert into schema_migrations (name) values (${name})`;
			applied.push(name);
		}
	});
	return { applied };
}
