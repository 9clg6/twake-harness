import { loadConfig } from '../config.js';
import { makeDb } from './client.js';
import { runMigrations } from './migrate.js';

const config = loadConfig(process.env);
const db = makeDb(config.databaseUrl);
const report = await runMigrations(db);
process.stdout.write(`${JSON.stringify({ msg: 'migrations applied', applied: report.applied })}\n`);
await db.close();
