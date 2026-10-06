import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { z } from 'zod';

import { makeAgentService, type AgentService } from './agent/service.js';
import { runTool } from './agent/tools.js';
import { makeAssistantService, type AssistantService } from './assistants/service.js';
import { makeJwtAuthenticator, type Authenticator } from './auth/jwt.js';
import type { Config } from './config.js';
import { withPrincipal, type Db } from './db/client.js';
import type { LlmClient } from './llm/client.js';
import { makeMatrixAdmin } from './matrix/admin.js';
import { listMemory } from './memory/repository.js';
import type { Principal } from './principals/principal.js';
import { ensurePrincipal, type PrincipalRecord } from './principals/repository.js';
import { findSession, listSessionIds } from './sessions/repository.js';
import {
	findSkill,
	insertSkill,
	isValidSkillId,
	listSkills,
	setSkillStatus,
	toSkillMarkdown
} from './skills/repository.js';

declare module 'fastify' {
	interface FastifyRequest {
		principal: Principal | null;
	}
	interface FastifyInstance {
		// The agent behind the routes, shared with the turn worker of the same process
		agent: AgentService;
	}
}

export interface AppOptions {
	readonly config: Config;
	readonly db: Db;
	readonly logStream?: Writable;
	readonly authenticator?: Authenticator;
	readonly llm?: LlmClient;
	readonly assistants?: AssistantService;
	readonly agent?: AgentService;
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

const skillBodySchema = z
	.object({
		name: z.string().min(1).max(80),
		description: z.string().min(1).max(500),
		content: z.string().min(1).max(20_000)
	})
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

	const agent =
		options.agent ??
		makeAgentService({
			config,
			db,
			log: app.log,
			...(options.llm === undefined ? {} : { llm: options.llm })
		});
	app.decorate('agent', agent);
	const tools = agent.tools;

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

			// Skills: one library per user, one for the organization, proposals approved by their
			// owner or promoted by an administrator, by copy
			scope.get('/skills', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('skills.read_own')) return reply.code(403).send(FORBIDDEN);
				const skills = await withPrincipal(db, principal, (tx) => listSkills(tx));
				return { skills: skills.map((s) => s.id), details: skills };
			});

			scope.get('/skills/proposals', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('skills.read_own')) return reply.code(403).send(FORBIDDEN);
				const admin = record.actions.includes('skills.admin');
				const proposals = await withPrincipal(db, principal, (tx) => listSkills(tx, 'proposed'), {
					admin
				});
				return { proposals };
			});

			scope.get<{ Params: { id: string } }>('/skills/:id', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('skills.read_own')) return reply.code(403).send(FORBIDDEN);
				if (!isValidSkillId(request.params.id)) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				const skill = await withPrincipal(db, principal, (tx) => findSkill(tx, request.params.id));
				if (skill === null) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				return {
					id: skill.id,
					scope: skill.scope,
					status: skill.status,
					content: toSkillMarkdown(skill)
				};
			});

			scope.post('/skills', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('skills.read_own')) return reply.code(403).send(FORBIDDEN);
				const parsed = skillBodySchema.safeParse(request.body);
				if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
				const skill = await withPrincipal(db, principal, (tx) =>
					insertSkill(tx, { scope: 'user', owner: principal.id, status: 'active', ...parsed.data })
				);
				return reply.code(201).send({ id: skill.id, scope: skill.scope, status: skill.status });
			});

			scope.post<{ Params: { id: string } }>(
				'/skills/proposals/:id/approve',
				async (request, reply) => {
					const principal = principalOf(request);
					const record = await loadPrincipal(principal);
					if (!record.actions.includes('skills.read_own')) return reply.code(403).send(FORBIDDEN);
					if (!isValidSkillId(request.params.id)) return reply.code(404).send(RESOURCE_UNAVAILABLE);
					const approved = await withPrincipal(db, principal, async (tx) => {
						const skill = await findSkill(tx, request.params.id);
						if (
							skill === null ||
							skill.scope !== 'user' ||
							skill.owner !== principal.id ||
							skill.status !== 'proposed'
						) {
							return false;
						}
						return setSkillStatus(tx, skill.id, 'active');
					});
					return approved
						? { id: request.params.id, status: 'active' }
						: reply.code(404).send(RESOURCE_UNAVAILABLE);
				}
			);

			scope.post('/org/skills', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('skills.admin')) return reply.code(403).send(FORBIDDEN);
				const parsed = skillBodySchema.safeParse(request.body);
				if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
				const skill = await withPrincipal(
					db,
					principal,
					(tx) => insertSkill(tx, { scope: 'org', owner: 'org', status: 'active', ...parsed.data }),
					{ admin: true }
				);
				return reply.code(201).send({ id: skill.id, scope: skill.scope, status: skill.status });
			});

			// Promotion copies a user's proposal into the organization library and leaves it theirs
			scope.post<{ Params: { id: string } }>('/org/skills/promote/:id', async (request, reply) => {
				const principal = principalOf(request);
				const record = await loadPrincipal(principal);
				if (!record.actions.includes('skills.admin')) return reply.code(403).send(FORBIDDEN);
				if (!isValidSkillId(request.params.id)) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				const promoted = await withPrincipal(
					db,
					principal,
					async (tx) => {
						const proposal = await findSkill(tx, request.params.id);
						if (proposal === null || proposal.scope !== 'user') return null;
						return insertSkill(tx, {
							scope: 'org',
							owner: 'org',
							status: 'active',
							name: proposal.name,
							description: proposal.description,
							content: proposal.content
						});
					},
					{ admin: true }
				);
				return promoted === null
					? reply.code(404).send(RESOURCE_UNAVAILABLE)
					: reply
							.code(201)
							.send({ id: promoted.id, scope: promoted.scope, status: promoted.status });
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
				const result = await agent.runOwnerTurn({
					principal,
					target:
						body.session_id === undefined ? { kind: 'new' } : { kind: 'id', id: body.session_id },
					message: body.message,
					log: request.log
				});
				if (result.kind === 'forbidden') return reply.code(403).send(FORBIDDEN);
				if (result.kind === 'missing') return reply.code(404).send(RESOURCE_UNAVAILABLE);
				if (result.kind === 'failed') return reply.code(502).send({ error: 'execution failed' });
				return { session_id: result.sessionId, answer: result.answer, model: result.model };
			});
		},
		{ prefix: '/v1' }
	);

	return app;
}
