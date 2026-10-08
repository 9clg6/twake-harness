import { startTurnWorker } from './agent/turn-worker.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { makeDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { startMatrixRole } from './matrix/role.js';
import { startWorkerRole } from './worker/role.js';

const config = loadConfig(process.env);
const db = makeDb(config.databaseUrl);
const report = await runMigrations(db);

if (config.role === 'worker') {
	const worker = await startWorkerRole({ config, db });
	const { app } = worker;
	app.log.info({ role: config.role, applied: report.applied }, 'harness starting');
	const stop = async (signal: string): Promise<void> => {
		app.log.info({ signal }, 'harness stopping');
		await worker.stop();
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
	const worker = startTurnWorker({
		db,
		agent,
		log: app.log,
		locale: config.locale,
		turn: config.turn,
		requestLifetimeMs: config.consent.requestLifetimeMs
	});
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
