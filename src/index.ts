import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { makeDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';

const config = loadConfig(process.env);
const db = makeDb(config.databaseUrl);
const report = await runMigrations(db);
const app = await buildApp({ config, db });
app.log.info({ role: config.role, applied: report.applied }, 'harness starting');

async function shutdown(signal: string): Promise<void> {
	app.log.info({ signal }, 'harness stopping');
	await app.close();
	await db.close();
	process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
