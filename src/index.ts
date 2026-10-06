import { startTurnWorker } from './agent/turn-worker.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { startCurationScheduler } from './curation/curation.js';
import { makeDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { startMatrixRole } from './matrix/role.js';

const config = loadConfig(process.env);
const db = makeDb(config.databaseUrl);
const report = await runMigrations(db);

if (config.role === 'worker') {
	// Serves its health check; the API routes stay behind APISIX, which never routes here
	const app = await buildApp({ config, db });
	app.log.info({ role: config.role, applied: report.applied }, 'harness starting');
	const scheduler = startCurationScheduler(db, app.log, config.curation.intervalMs);
	const stop = async (signal: string): Promise<void> => {
		app.log.info({ signal }, 'harness stopping');
		scheduler.stop();
		await app.close();
		await db.close();
		process.exit(0);
	};
	process.on('SIGTERM', () => void stop('SIGTERM'));
	process.on('SIGINT', () => void stop('SIGINT'));
	await app.listen({ host: config.host, port: config.port });
} else if (config.role === 'matrix') {
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
	const agent = app.agent;
	app.log.info({ role: config.role, applied: report.applied }, 'harness starting');
	await agent.contracts.load();
	const worker = startTurnWorker({ db, agent, log: app.log });
	const shutdown = async (signal: string): Promise<void> => {
		app.log.info({ signal }, 'harness stopping');
		agent.contracts.stop();
		await worker.stop();
		await app.close();
		await db.close();
		process.exit(0);
	};
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('SIGINT', () => void shutdown('SIGINT'));
	await app.listen({ host: config.host, port: config.port });
}
