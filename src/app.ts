import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { makeJwtAuthenticator, type Authenticator } from './auth/jwt.js';
import type { Config } from './config.js';
import { withPrincipal, type Db } from './db/client.js';
import type { Principal } from './principals/principal.js';
import { ensurePrincipal } from './principals/repository.js';

declare module 'fastify' {
	interface FastifyRequest {
		principal: Principal | null;
	}
}

export interface AppOptions {
	readonly config: Config;
	readonly db: Db;
	readonly logStream?: Writable;
	readonly authenticator?: Authenticator;
}

const REQUEST_ID_HEADER = 'x-request-id';

function requestIdOf(request: { headers: Record<string, string | string[] | undefined> }): string {
	const given = request.headers[REQUEST_ID_HEADER];
	return typeof given === 'string' && given.length > 0 && given.length <= 128
		? given
		: randomUUID();
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
	const { config, db } = options;
	const authenticate = options.authenticator ?? makeJwtAuthenticator(config.auth);
	const app = Fastify({
		logger: {
			level: config.logLevel,
			...(options.logStream === undefined ? {} : { stream: options.logStream })
		},
		genReqId: requestIdOf,
		requestIdHeader: false
	});

	app.decorateRequest('principal', null);
	app.addHook('onSend', async (request, reply) => {
		reply.header(REQUEST_ID_HEADER, request.id);
	});

	app.get('/health', async () => ({ status: 'ok' }));

	await app.register(
		async (scope) => {
			// Identity is settled before any other work: a refused token never reaches the database.
			scope.addHook('preHandler', async (request: FastifyRequest, reply) => {
				const result = await authenticate(request.headers.authorization);
				if (!result.ok) {
					request.log.info({ reason: result.reason }, 'request refused');
					return reply.code(401).send({ error: 'invalid token' });
				}
				request.principal = result.principal;
			});

			scope.get('/me', async (request) => {
				const principal = request.principal;
				if (principal === null) {
					throw new Error('authenticated route reached without a principal');
				}
				const record = await withPrincipal(db, principal, (tx) => ensurePrincipal(tx, principal));
				return { user: record.id, actions: record.actions };
			});
		},
		{ prefix: '/v1' }
	);

	return app;
}
