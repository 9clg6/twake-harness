import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { z } from 'zod';

import { makeTurnGate } from './agent/gate.js';
import { DEFAULT_SYSTEM_PROMPT } from './agent/persona.js';
import { buildSystemPrompt } from './agent/prompt.js';
import {
	clarifyTool,
	makeToolRegistry,
	memoryTool,
	runTool,
	sessionsListTool,
	sessionsReadTool
} from './agent/tools.js';
import { runTurn, TurnError } from './agent/turn.js';
import { makeAssistantService, type AssistantService } from './assistants/service.js';
import { makeJwtAuthenticator, type Authenticator } from './auth/jwt.js';
import type { Config } from './config.js';
import { withPrincipal, type Db } from './db/client.js';
import { LlmError, makeLlmClient, type LlmClient } from './llm/client.js';
import { makeMatrixAdmin } from './matrix/admin.js';
import { listMemory } from './memory/repository.js';
import type { Principal } from './principals/principal.js';
import { ensurePrincipal, type PrincipalRecord } from './principals/repository.js';
import {
	createSession,
	findSession,
	listSessionIds,
	saveSessionMessages
} from './sessions/repository.js';

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
	readonly assistants?: AssistantService;
}

const assistantBodySchema = z.object({ name: z.string().min(1).max(64) }).strict();

const chatBodySchema = z
	.object({
		message: z.string().min(1).max(32_768),
		session_id: z
			.string()
			.regex(/^[0-9a-f]{32}$/)
			.optional()
	})
	.strict();

const toolBodySchema = z
	.object({ tool: z.string().min(1), arguments: z.unknown().optional() })
	.strict();

const RESOURCE_UNAVAILABLE = { error: 'resource unavailable' } as const;
const FORBIDDEN = { error: 'forbidden' } as const;
const SESSION_ID = /^[0-9a-f]{32}$/;

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
	const tools = makeToolRegistry([clarifyTool, memoryTool, sessionsListTool, sessionsReadTool]);
	const gate = makeTurnGate();

	async function loadPrincipal(principal: Principal): Promise<PrincipalRecord> {
		return withPrincipal(db, principal, (tx) => ensurePrincipal(tx, principal));
	}
	const app = Fastify({
		logger: {
			level: config.logLevel,
			...(options.logStream === undefined ? {} : { stream: options.logStream })
		},
		genReqId: requestIdOf,
		requestIdHeader: false
	});

	const assistants =
		options.assistants ??
		makeAssistantService({
			config,
			db,
			log: app.log,
			admin: makeMatrixAdmin({
				apisixBaseUrl: config.apisix.baseUrl,
				consumerKey: config.apisix.consumerKey,
				asToken: config.matrix.asToken
			})
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

			// The same operations as the creator conversation, for the Twake Chat front
			scope.post('/assistants', async (request, reply) => {
				const principal = principalOf(request);
				const parsed = assistantBodySchema.safeParse(request.body);
				if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
				const created = await assistants.create(principal.id, parsed.data.name);
				if (!created.ok) {
					return created.reason === 'exists'
						? reply.code(409).send({ error: 'assistant already exists' })
						: reply.code(400).send({ error: 'invalid request' });
				}
				return reply.code(201).send(created.assistant);
			});

			scope.get('/assistants/me', async (request, reply) => {
				const assistant = await assistants.find(principalOf(request).id);
				return assistant === null ? reply.code(404).send(RESOURCE_UNAVAILABLE) : assistant;
			});

			scope.put('/assistants/me', async (request, reply) => {
				const parsed = assistantBodySchema.safeParse(request.body);
				if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
				const renamed = await assistants.rename(principalOf(request).id, parsed.data.name);
				return renamed === null ? reply.code(404).send(RESOURCE_UNAVAILABLE) : renamed;
			});

			scope.delete('/assistants/me', async (request, reply) => {
				const removed = await assistants.remove(principalOf(request).id);
				return removed ? reply.code(204).send() : reply.code(404).send(RESOURCE_UNAVAILABLE);
			});

			scope.get('/sessions', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('sessions.read_own')) return reply.code(403).send(FORBIDDEN);
				const sessions = await withPrincipal(db, principal, (tx) => listSessionIds(tx));
				return { sessions };
			});

			scope.get<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('sessions.read_own')) return reply.code(403).send(FORBIDDEN);
				if (!SESSION_ID.test(request.params.id)) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				const session = await withPrincipal(db, principal, (tx) =>
					findSession(tx, request.params.id)
				);
				if (session === null) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				return { messages: session.messages };
			});

			scope.get('/memory', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('memory.read_own')) return reply.code(403).send(FORBIDDEN);
				return withPrincipal(db, principal, (tx) => listMemory(tx, principal.id));
			});

			// Direct tool calls, under the same rules as the model's: identity from the token only,
			// unknown tools and unknown arguments refused, ownership enforced by the database.
			scope.post('/tool', async (request, reply) => {
				const principal = principalOf(request);
				const parsed = toolBodySchema.safeParse(request.body);
				if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
				const tool = tools.find(parsed.data.tool);
				if (tool === null) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				const record = await loadPrincipal(principal);
				if (tool.requiredAction !== null && !record.actions.includes(tool.requiredAction)) {
					return reply.code(403).send(FORBIDDEN);
				}
				const outcome = await runTool(tool, parsed.data.arguments ?? {}, {
					principalId: principal.id,
					actions: record.actions,
					db
				});
				request.log.info(
					{ tool: parsed.data.tool, arguments: parsed.data.arguments, result: outcome.result },
					'tool called'
				);
				if (outcome.denied === true) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				return outcome.result;
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
							return {
								kind: 'ok' as const,
								session: await createSession(tx, principal.id),
								actions: record.actions
							};
						}
						const session = await findSession(tx, body.session_id);
						return session === null
							? { kind: 'missing' as const }
							: { kind: 'ok' as const, session, actions: record.actions };
					});
					if (opened.kind === 'forbidden') return reply.code(403).send(FORBIDDEN);
					if (opened.kind === 'missing') return reply.code(404).send(RESOURCE_UNAVAILABLE);
					const session = opened.session;
					const actions = opened.actions;
					const memory = actions.includes('memory.read_own')
						? await withPrincipal(db, principal, (tx) => listMemory(tx, principal.id))
						: { memory: [], user: [] };
					const log = request.log.child({ session: session.id, principal: principal.id });
					log.info({ messageLength: body.message.length }, 'turn started');
					try {
						const turn = await runTurn(
							{ llm, tools, log, maxToolCalls: config.turn.maxToolCalls },
							{
								systemPrompt: buildSystemPrompt({
									persona: DEFAULT_SYSTEM_PROMPT,
									memory,
									history: session.messages,
									nudgeInterval: config.turn.memoryNudgeInterval
								}),
								history: session.messages,
								message: body.message,
								context: { principalId: principal.id, actions, db }
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
