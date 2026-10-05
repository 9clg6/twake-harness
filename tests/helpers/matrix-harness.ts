import { PassThrough } from 'node:stream';

import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { makeDb, type Db } from '../../src/db/client.js';
import { buildRegistrationFile } from '../../src/matrix/registration.js';
import { startMatrixRole, type MatrixRole } from '../../src/matrix/role.js';
import { resetDatabase, TEST_DATABASE_URL } from './app.js';
import { startFakeApisix, type FakeApisix } from './fake-apisix.js';
import { freePort, startTestSynapse, SYNAPSE_SERVER_NAME, type TestSynapse } from './synapse.js';

export interface MatrixTestHarness {
	readonly synapse: TestSynapse;
	readonly apisix: FakeApisix;
	readonly role: MatrixRole;
	readonly config: Config;
	readonly db: Db;
	readonly port: number;
	readonly hsToken: string;
	logLines(): Record<string, unknown>[];
	close(): Promise<void>;
}

// The matrix role, a real Synapse pushing to it and the fake APISIX in between for its calls.
export async function startMatrixHarness(): Promise<MatrixTestHarness> {
	const port = await freePort();
	const asToken = 'as-token-test';
	const hsToken = 'hs-token-test';
	const apisix = await startFakeApisix();
	const config = loadConfig({
		HARNESS_ROLE: 'matrix',
		DATABASE_URL: TEST_DATABASE_URL,
		AUTH_JWKS_URL: 'http://127.0.0.1:1/jwks.json',
		AUTH_ISSUER: 'x',
		AUTH_AUDIENCE: 'y',
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
	const app = await buildApp({ config, db, logStream });
	const role = await startMatrixRole({ config, db, log: app.log, port, bindAddress: '0.0.0.0' });
	return {
		synapse,
		apisix,
		role,
		config,
		db,
		port,
		hsToken,
		logLines: () =>
			chunks
				.join('')
				.split('\n')
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as Record<string, unknown>),
		close: async () => {
			await role.stop();
			await app.close();
			await db.close();
			await synapse.stop();
			await apisix.close();
		}
	};
}
