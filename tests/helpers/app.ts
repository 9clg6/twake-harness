import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { makeDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { startTestIssuer, type TestIssuer } from './jwks-server.js';

// The container's own user is a superuser, which bypasses row-level security. Tests therefore run
// the harness as a plain role, created here once, exactly like the production role will be.
const ADMIN_DATABASE_URL: string =
	process.env['TEST_ADMIN_DATABASE_URL'] ?? 'postgres://harness:harness@127.0.0.1:5433/harness';
const APP_ROLE = 'harness_app';
const APP_PASSWORD = 'harness_app';

function appDatabaseUrl(adminUrl: string): string {
	const url = new URL(adminUrl);
	url.username = APP_ROLE;
	url.password = APP_PASSWORD;
	return url.toString();
}

export const TEST_DATABASE_URL: string = appDatabaseUrl(ADMIN_DATABASE_URL);

let appRoleReady = false;

async function ensureAppRole(): Promise<void> {
	if (appRoleReady) return;
	const admin = makeDb(ADMIN_DATABASE_URL);
	try {
		await admin.sql.unsafe(`do $$ begin
			if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
				create role ${APP_ROLE} login password '${APP_PASSWORD}' nosuperuser nobypassrls;
			end if;
		end $$`);
		const database = new URL(ADMIN_DATABASE_URL).pathname.slice(1);
		await admin.sql.unsafe(`grant all on database "${database}" to ${APP_ROLE}`);
		// A fresh schema owned by the application role: its tables are then its own, and the
		// forced row-level security applies to it as it will to the production role.
		await admin.sql.unsafe('drop schema public cascade');
		await admin.sql.unsafe(`create schema public authorization ${APP_ROLE}`);
	} finally {
		await admin.close();
	}
	appRoleReady = true;
}

export interface TestHarness {
	readonly app: FastifyInstance;
	readonly db: Db;
	readonly issuer: TestIssuer;
	readonly config: Config;
	logLines(): Record<string, unknown>[];
	close(): Promise<void>;
}

export async function resetDatabase(db: Db): Promise<void> {
	await runMigrations(db);
	await db.sql.unsafe('truncate table principals');
}

export async function startTestHarness(): Promise<TestHarness> {
	await ensureAppRole();
	const issuer = await startTestIssuer();
	const config = loadConfig({
		HARNESS_ROLE: 'api',
		DATABASE_URL: TEST_DATABASE_URL,
		AUTH_JWKS_URL: issuer.jwksUrl.toString(),
		AUTH_ISSUER: issuer.issuer,
		AUTH_AUDIENCE: issuer.audience,
		LOG_LEVEL: 'info'
	});
	const db = makeDb(config.databaseUrl);
	await resetDatabase(db);
	const logStream = new PassThrough();
	const chunks: string[] = [];
	logStream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
	const app = await buildApp({ config, db, logStream });
	await app.ready();
	return {
		app,
		db,
		issuer,
		config,
		logLines: () =>
			chunks
				.join('')
				.split('\n')
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as Record<string, unknown>),
		close: async () => {
			await app.close();
			await db.close();
			await issuer.close();
		}
	};
}
