import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '../config.js';
import { withPrincipal, type Db } from '../db/client.js';
import { LlmError, makeLlmClient, type LlmClient } from '../llm/client.js';
import { listMemory } from '../memory/repository.js';
import type { Principal } from '../principals/principal.js';
import { ensurePrincipal } from '../principals/repository.js';
import {
	createSession,
	ensureRoomSession,
	findSession,
	saveSessionMessages,
	type SessionRecord
} from '../sessions/repository.js';
import { makeTurnGate, type TurnGate } from './gate.js';
import { DEFAULT_SYSTEM_PROMPT } from './persona.js';
import { buildSystemPrompt } from './prompt.js';
import {
	clarifyTool,
	makeToolRegistry,
	memoryTool,
	sessionsListTool,
	sessionsReadTool,
	type ToolRegistry
} from './tools.js';
import { runTurn, TurnError } from './turn.js';

export type SessionTarget =
	| { readonly kind: 'new' }
	| { readonly kind: 'id'; readonly id: string }
	| { readonly kind: 'room'; readonly roomId: string };

export interface OwnerTurnInput {
	readonly principal: Principal;
	readonly target: SessionTarget;
	readonly message: string;
	readonly log: FastifyBaseLogger;
}

export type OwnerTurnResult =
	| {
			readonly kind: 'ok';
			readonly sessionId: string;
			readonly answer: string;
			readonly model: string;
	  }
	| { readonly kind: 'forbidden' }
	| { readonly kind: 'missing' }
	| { readonly kind: 'failed'; readonly error: string };

export interface AgentService {
	readonly llm: LlmClient;
	readonly tools: ToolRegistry;
	readonly gate: TurnGate;
	runOwnerTurn(input: OwnerTurnInput): Promise<OwnerTurnResult>;
}

export interface AgentServiceDeps {
	readonly config: Config;
	readonly db: Db;
	readonly llm?: LlmClient;
}

export function makeAgentService(deps: AgentServiceDeps): AgentService {
	const { config, db } = deps;
	const llm =
		deps.llm ??
		makeLlmClient({
			baseUrl: config.apisix.baseUrl,
			consumerKey: config.apisix.consumerKey,
			model: config.llm.model,
			maxTokens: config.llm.maxTokens,
			timeoutMs: config.llm.timeoutMs
		});
	const tools = makeToolRegistry([clarifyTool, memoryTool, sessionsListTool, sessionsReadTool]);
	const gate = makeTurnGate();

	async function runOwnerTurn(input: OwnerTurnInput): Promise<OwnerTurnResult> {
		const { principal, target, message } = input;
		return gate.run(principal.id, async () => {
			// A short transaction settles rights and the session; the model call runs outside it.
			const opened = await withPrincipal(db, principal, async (tx) => {
				const record = await ensurePrincipal(tx, principal);
				if (!record.actions.includes('chat')) return { kind: 'forbidden' as const };
				let session: SessionRecord | null;
				if (target.kind === 'new') session = await createSession(tx, principal.id);
				else if (target.kind === 'room')
					session = await ensureRoomSession(tx, principal.id, target.roomId);
				else session = await findSession(tx, target.id);
				return session === null
					? { kind: 'missing' as const }
					: { kind: 'ok' as const, session, actions: record.actions };
			});
			if (opened.kind !== 'ok') return opened;
			const { session, actions } = opened;
			const memory = actions.includes('memory.read_own')
				? await withPrincipal(db, principal, (tx) => listMemory(tx, principal.id))
				: { memory: [], user: [] };
			const log = input.log.child({ session: session.id, principal: principal.id });
			log.info({ messageLength: message.length }, 'turn started');
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
						message,
						context: { principalId: principal.id, actions, db }
					}
				);
				const saved = await withPrincipal(db, principal, (tx) =>
					saveSessionMessages(tx, session.id, turn.messages)
				);
				if (!saved) return { kind: 'missing' };
				log.info({ answerLength: turn.answer.length }, 'turn finished');
				return { kind: 'ok', sessionId: session.id, answer: turn.answer, model: llm.model };
			} catch (err: unknown) {
				if (err instanceof TurnError || err instanceof LlmError) {
					log.error({ err }, 'turn failed');
					return { kind: 'failed', error: err.message };
				}
				throw err;
			}
		});
	}

	return { llm, tools, gate, runOwnerTurn };
}
