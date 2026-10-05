import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { z } from 'zod';

import { makeTurnGate } from './agent/gate.js';
import { DEFAULT_SYSTEM_PROMPT } from './agent/persona.js';
import { clarifyTool, makeToolRegistry } from './agent/tools.js';
import { runTurn, TurnError } from './agent/turn.js';
import { makeJwtAuthenticator, type Authenticator } from './auth/jwt.js';
import type { Config } from './config.js';
import { withPrincipal, type Db } from './db/client.js';
import { LlmError, makeLlmClient, type LlmClient } from './llm/client.js';
import type { Principal } from './principals/principal.js';
import { ensurePrincipal } from './principals/repository.js';
import { createSession, findSession, saveSessionMessages } from './sessions/repository.js';

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
	readonly llm?: LlmClient;
}

const chatBodySchema = z
	.object({
		message: z.string().min(1).max(32_768),
		session_id: z
			.string()
			.regex(/^[0-9a-f]{32}$/)
			.optional()
	})
	.strict();

const RESOURCE_UNAVAILABLE = { error: 'resource unavailable' } as const;

const REQUEST_ID_HEADER = 'x-request-id';

function requestIdOf(request: { headers: Record<string, string | string[] | undefined> }): string {
	const given = request.headers[REQUEST_ID_HEADER];
	return typeof given === 'string' && given.length > 0 && given.length <= 128
		? given
		: randomUUID();
}

function principalOf(request: FastifyRequest): Principal {
	if (request.principal === null) {
		throw new Error('authenticated route reached without a principal');
	}
	return request.principal;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
	const { config, db } = options;
	const authenticate = options.authenticator ?? makeJwtAuthenticator(config.auth);
	const llm =
		options.llm ??
		makeLlmClient({
			baseUrl: config.apisix.baseUrl,
			consumerKey: config.apisix.consumerKey,
			model: config.llm.model,
			maxTokens: config.llm.maxTokens,
			timeoutMs: config.llm.timeoutMs
		});
	const tools = makeToolRegistry([clarifyTool]);
	const gate = makeTurnGate();
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
				const principal = principalOf(request);
				const record = await withPrincipal(db, principal, (tx) => ensurePrincipal(tx, principal));
				return { user: record.id, actions: record.actions };
			});

			scope.post('/chat', async (request, reply) => {
				const principal = principalOf(request);
				const parsed = chatBodySchema.safeParse(request.body);
				if (!parsed.success) {
					return reply.code(400).send({ error: 'invalid request' });
				}
				const body = parsed.data;
				return gate.run(principal.id, async () => {
					// A short transaction settles rights and the session; the model call runs outside it.
					const opened = await withPrincipal(db, principal, async (tx) => {
						const record = await ensurePrincipal(tx, principal);
						if (!record.actions.includes('chat')) return { kind: 'forbidden' as const };
						if (body.session_id === undefined) {
							return { kind: 'ok' as const, session: await createSession(tx, principal.id) };
						}
						const session = await findSession(tx, body.session_id);
						return session === null
							? { kind: 'missing' as const }
							: { kind: 'ok' as const, session };
					});
					if (opened.kind === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
					if (opened.kind === 'missing') return reply.code(404).send(RESOURCE_UNAVAILABLE);
					const session = opened.session;
					const log = request.log.child({ session: session.id, principal: principal.id });
					log.info({ messageLength: body.message.length }, 'turn started');
					try {
						const turn = await runTurn(
							{ llm, tools, log, maxToolCalls: config.turn.maxToolCalls },
							{
								systemPrompt: DEFAULT_SYSTEM_PROMPT,
								history: session.messages,
								message: body.message,
								context: { principalId: principal.id }
							}
						);
						const saved = await withPrincipal(db, principal, (tx) =>
							saveSessionMessages(tx, session.id, turn.messages)
						);
						if (!saved) return reply.code(404).send(RESOURCE_UNAVAILABLE);
						log.info({ answerLength: turn.answer.length }, 'turn finished');
						return { session_id: session.id, answer: turn.answer, model: llm.model };
					} catch (err: unknown) {
						if (err instanceof TurnError || err instanceof LlmError) {
							log.error({ err }, 'turn failed');
							return reply.code(502).send({ error: 'execution failed' });
						}
						throw err;
					}
				});
			});
		},
		{ prefix: '/v1' }
	);

	return app;
}
