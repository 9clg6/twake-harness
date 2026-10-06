import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';

import { startTurnWorker } from '../../src/agent/turn-worker.js';
import type { JobWorker } from '../../src/jobs/worker.js';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { makeDb, type Db } from '../../src/db/client.js';
import { buildRegistrationFile } from '../../src/matrix/registration.js';
import { startMatrixRole, type MatrixRole } from '../../src/matrix/role.js';
import { resetDatabase, TEST_DATABASE_URL, TEST_REPLICAS } from './app.js';
import { makeClient, type TestClient } from './client.js';
import { startFakeApisix, type FakeApisix } from './fake-apisix.js';
import { startTestIssuer, type TestIssuer } from './jwks-server.js';
import { freePort, startTestSynapse, SYNAPSE_SERVER_NAME, type TestSynapse } from './synapse.js';

export interface MatrixTestHarness {
	readonly synapse: TestSynapse;
	readonly apisix: FakeApisix;
	readonly role: MatrixRole;
	readonly config: Config;
	readonly db: Db;
	readonly port: number;
	readonly hsToken: string;
	readonly issuer: TestIssuer;
	// The api role on the same database, driven over HTTP
	readonly api: TestClient;
	logLines(): Record<string, unknown>[];
	close(): Promise<void>;
}

// The matrix role, a real Synapse pushing to it and the fake APISIX in between for its calls.
export async function startMatrixHarness(): Promise<MatrixTestHarness> {
	const port = await freePort();
	const asToken = 'as-token-test';
	const hsToken = 'hs-token-test';
	const apisix = await startFakeApisix();
	const issuer = await startTestIssuer();
	const config = loadConfig({
		HARNESS_ROLE: 'matrix',
		DATABASE_URL: TEST_DATABASE_URL,
		AUTH_JWKS_URL: issuer.jwksUrl.toString(),
		AUTH_ISSUER: issuer.issuer,
		AUTH_AUDIENCE: issuer.audience,
		APISIX_BASE_URL: apisix.baseUrl,
		APISIX_CONSUMER_KEY: apisix.consumerKey,
		MATRIX_SERVER_NAME: SYNAPSE_SERVER_NAME,
		MATRIX_AS_TOKEN: asToken,
		MATRIX_HS_TOKEN: hsToken,
		LOG_LEVEL: 'info'
	});
	const synapse = await startTestSynapse({
		file: buildRegistrationFile(config, `http://host.docker.internal:${port}`)
	});
	apisix.matrixUpstream = synapse.url;
	const db = makeDb(config.databaseUrl);
	await resetDatabase(db);
	const logStream = new PassThrough();
	const chunks: string[] = [];
	logStream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
	// The api role, replicated as in the deployment: each replica has its own turn worker
	const apps: FastifyInstance[] = [];
	const workers: JobWorker[] = [];
	for (let i = 0; i < TEST_REPLICAS; i += 1) {
		const replica = await buildApp({ config, db, logStream });
		await replica.ready();
		apps.push(replica);
		workers.push(
			startTurnWorker({ db, agent: replica.agent, log: replica.log, pollIntervalMs: 100 })
		);
	}
	const app = apps[0];
	if (app === undefined) throw new Error('no replica started');
	const role = await startMatrixRole({
		config,
		db,
		log: app.log,
		port,
		bindAddress: '0.0.0.0',
		pollIntervalMs: 100
	});
	const api = makeClient({ app, apps, issuer });
	return {
		synapse,
		apisix,
		role,
		config,
		db,
		port,
		hsToken,
		issuer,
		api,
		logLines: () =>
			chunks
				.join('')
				.split('\n')
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as Record<string, unknown>),
		close: async () => {
			for (const worker of workers) await worker.stop();
			await role.stop();
			for (const replica of apps) await replica.close();
			await db.close();
			await synapse.stop();
			await apisix.close();
			await issuer.close();
		}
	};
}
