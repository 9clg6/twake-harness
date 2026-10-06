import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { z } from 'zod';

import type { Clock } from './agent/clock.js';
import { makeAgentService, type AgentService } from './agent/service.js';
import { runTool, toolCallStatus } from './agent/tools.js';
import type { TurnPayload } from './agent/turn-worker.js';
import { findAssistant } from './assistants/repository.js';
import { makeAssistantService, type AssistantService } from './assistants/service.js';
import { makeJwtAuthenticator, type Authenticator } from './auth/jwt.js';
import type { Config } from './config.js';
import { withPrincipal, type Db } from './db/client.js';
import { getMessages, type Messages } from './i18n/messages.js';
import { enqueueJob } from './jobs/queue.js';
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
	// The present as the agent reads it; the system clock unless a test sets its own
	readonly clock?: Clock;
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
// The owner has no account on the homeserver the assistants live on, so no room can be opened
const OWNER_NOT_ON_HOMESERVER = { error: 'owner not on the homeserver' } as const;

const eventSchema = z.object({
	owner: z.string().min(1).max(128),
	event_id: z.string().min(1).max(200),
	type: z.string().min(1).max(100)
});

// What the assistant is told when an event arrives, as a message of its owner in their room, in
// the deployment's language. The turn may read but never act: an invitation is read, checked
// against the calendar and proposed, and only the owner's answer, in a turn of their own in the
// same room, can accept it.
function eventMessage(messages: Messages, type: string, eventId: string): string {
	return type.startsWith('calendar.invitation')
		? messages.events.invitation(type, eventId)
		: messages.events.other(type, eventId);
}
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
			...(options.llm === undefined ? {} : { llm: options.llm }),
			...(options.clock === undefined ? {} : { clock: options.clock })
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

	// Behind the gateway only: when a shared secret is set, every request of the API carries it,
	// which the gateway injects and nobody else knows; the health check and the metrics stay open
	if (config.gateway.sharedSecret !== null) {
		const secret = config.gateway.sharedSecret;
		app.addHook('onRequest', async (request, reply) => {
			if (!request.url.startsWith('/v1/')) return;
			if (request.headers['x-twake-gateway'] !== secret) {
				request.log.info({ reason: 'gateway' }, 'request refused');
				return reply.code(403).send(FORBIDDEN);
			}
		});
	}

	app.get('/health', async () => ({ status: 'ok' }));

	// An event the dispatcher posts for an owner wakes their assistant: the turn runs in the
	// owner's room, reads the event through the contracts and tells the owner. Only the service
	// clients named in the settings may post one, never a user.
	app.post('/v1/events', async (request, reply) => {
		const auth = await authenticate(request.headers.authorization);
		if (!auth.ok) {
			request.log.info({ reason: auth.reason }, 'event refused');
			return reply.code(401).send({ error: 'invalid token' });
		}
		const client = auth.principal.id;
		if (!config.events.clientIds.includes(client)) {
			request.log.info({ client, reason: 'not_a_dispatcher' }, 'event refused');
			return reply.code(403).send(FORBIDDEN);
		}
		const parsed = eventSchema.safeParse(request.body);
		if (!parsed.success) return reply.code(400).send({ error: 'invalid event' });
		const { owner, event_id: eventId, type } = parsed.data;
		const assistant = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
		if (assistant === null || assistant.deletedAt !== null || assistant.roomId === null) {
			request.log.info({ client, owner, eventId, reason: 'no_assistant' }, 'event refused');
			return reply.code(404).send({ error: 'no assistant' });
		}
		const seen = await db.sql`
			insert into events_seen (event_id, owner) values (${eventId}, ${owner}) on conflict (event_id) do nothing`;
		if (seen.count === 0) {
			request.log.info({ client, owner, eventId, type }, 'event duplicate');
			return reply.code(200).send({ queued: false, duplicate: true });
		}
		const payload: TurnPayload = {
			owner,
			roomId: assistant.roomId,
			eventId: `event:${eventId}`,
			text: eventMessage(getMessages(config.locale), type, eventId),
			origin: 'event'
		};
		await enqueueJob(db, {
			kind: 'turn',
			payload,
			dedupKey: `event:${eventId}`,
			groupKey: `turn:${owner}`
		});
		request.log.info({ client, owner, eventId, type }, 'event queued');
		return reply.code(202).send({ queued: true, duplicate: false });
	});

	// Prometheus exposition: what the autoscaler and the dashboards read
	app.get('/metrics', async (_request, reply) => {
		const snapshot = agent.admission.snapshot();
		const assistants = await db.sql<
			{ n: number }[]
		>`select count(*)::int as n from assistant_rooms`;
		const lines = [
			'# TYPE harness_turns_inflight gauge',
			`harness_turns_inflight ${snapshot.inflight}`,
			'# TYPE harness_turns_queued gauge',
			`harness_turns_queued ${snapshot.queued}`,
			'# TYPE harness_turns_refused_total counter',
			...Object.entries(snapshot.refused).map(
				([reason, n]) => `harness_turns_refused_total{reason="${reason}"} ${n}`
			),
			'# TYPE harness_assistants_held gauge',
			`harness_assistants_held ${assistants[0]?.n ?? 0}`
		];
		return reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
	});

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
					switch (created.reason) {
						case 'exists':
							return reply.code(409).send({ error: 'assistant already exists' });
						case 'not_on_homeserver':
							return reply.code(422).send(OWNER_NOT_ON_HOMESERVER);
						default:
							return reply.code(400).send({ error: 'invalid request' });
					}
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

			// After a lost encryption store, the owner asks for the assistant's escrowed identity back
			scope.post('/assistants/me/recover', async (request, reply) => {
				const principal = principalOf(request);
				const assistant = await assistants.find(principal.id);
				if (assistant === null) return reply.code(404).send(RESOURCE_UNAVAILABLE);
				const queued = await enqueueJob(db, {
					kind: 'recover',
					payload: { owner: principal.id },
					dedupKey: `recover:${principal.id}`,
					groupKey: `send:${assistant.roomId ?? principal.id}`
				});
				request.log.info({ principal: principal.id, queued }, 'recovery requested');
				return reply.code(202).send({ queued });
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
				const started = performance.now();
				const outcome = await runTool(tool, parsed.data.arguments ?? {}, {
					principalId: principal.id,
					actions: record.actions,
					db,
					correlationId: request.id
				});
				request.log.info(
					{
						tool: parsed.data.tool,
						status: toolCallStatus(outcome),
						durationMs: Math.round(performance.now() - started)
					},
					'tool called'
				);
				request.log.debug(
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
					log: request.log,
					correlationId: request.id
				});
				if (result.kind === 'forbidden') return reply.code(403).send(FORBIDDEN);
				if (result.kind === 'missing') return reply.code(404).send(RESOURCE_UNAVAILABLE);
				if (result.kind === 'busy')
					return reply.code(429).send({ error: 'busy', reason: result.reason });
				if (result.kind === 'failed') return reply.code(502).send({ error: 'execution failed' });
				return { session_id: result.sessionId, answer: result.answer, model: result.model };
			});
		},
		{ prefix: '/v1' }
	);

	return app;
}
