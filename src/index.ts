import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { makeDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { startMatrixRole } from './matrix/role.js';

const config = loadConfig(process.env);
const db = makeDb(config.databaseUrl);
const report = await runMigrations(db);

if (config.role === 'matrix') {
	const app = await buildApp({ config, db });
	app.log.info({ role: config.role, applied: report.applied }, 'harness starting');
	const role = await startMatrixRole({
		config,
		db,
		log: app.log,
		port: config.port,
		bindAddress: config.host
	});
	const stop = async (signal: string): Promise<void> => {
		app.log.info({ signal }, 'harness stopping');
		await role.stop();
		await db.close();
		process.exit(0);
	};
	process.on('SIGTERM', () => void stop('SIGTERM'));
	process.on('SIGINT', () => void stop('SIGINT'));
} else {
	const app = await buildApp({ config, db });
	app.log.info({ role: config.role, applied: report.applied }, 'harness starting');
	const shutdown = async (signal: string): Promise<void> => {
		app.log.info({ signal }, 'harness stopping');
		await app.close();
		await db.close();
		process.exit(0);
	};
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('SIGINT', () => void shutdown('SIGINT'));
	await app.listen({ host: config.host, port: config.port });
}
