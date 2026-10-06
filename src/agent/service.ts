import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '../config.js';
import { makeContractCatalog, type ContractCatalog } from '../contracts/catalog.js';
import { ACT_THROUGH_CONTRACTS } from '../contracts/tools.js';
import { withPrincipal, type Db } from '../db/client.js';
import { LlmError, makeLlmClient, type LlmClient } from '../llm/client.js';
import { listMemory } from '../memory/repository.js';
import { ORGANIZATION_PRINCIPAL, type Principal } from '../principals/principal.js';
import { ensurePrincipal } from '../principals/repository.js';
import {
	createSession,
	ensureRoomSession,
	findSession,
	saveSessionMessages,
	type SessionRecord
} from '../sessions/repository.js';
import { makeAdmission, type Admission, type RefusalReason } from './admission.js';
import { makeTurnGate, type TurnGate } from './gate.js';
import { DEFAULT_SYSTEM_PROMPT, organizationPrompt } from './persona.js';
import { buildSystemPrompt } from './prompt.js';
import { listSkills } from '../skills/repository.js';
import {
	clarifyTool,
	makeToolRegistry,
	memoryTool,
	sessionSearchTool,
	sessionsListTool,
	sessionsReadTool,
	skillsListTool,
	skillsProposeTool,
	skillsReadTool,
	skillsSearchTool,
	type ToolRegistry
} from './tools.js';
import { runTurn, TurnError } from './turn.js';

export type SessionTarget =
	| { readonly kind: 'new' }
	| { readonly kind: 'id'; readonly id: string }
	| { readonly kind: 'room'; readonly roomId: string };

// Who started a turn: the owner, by a message or a request, or an event a dispatcher posted
export type TurnOrigin = 'owner' | 'event';

// What a turn an event started may not do, whatever its owner may: act through a contract. The
// event's own text comes from a third party, so only the owner's yes, in a turn of their own,
// can make the assistant act.
const WITHHELD_FROM_EVENT_TURNS: readonly string[] = [ACT_THROUGH_CONTRACTS];

export interface OwnerTurnInput {
	readonly principal: Principal;
	readonly target: SessionTarget;
	readonly message: string;
	readonly log: FastifyBaseLogger;
	// What links the turn's calls in the audit: the request id, or the Matrix event id
	readonly correlationId?: string;
	// The owner unless told otherwise
	readonly origin?: TurnOrigin;
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
	| { readonly kind: 'busy'; readonly reason: RefusalReason }
	| { readonly kind: 'failed'; readonly error: string };

export interface AgentService {
	readonly llm: LlmClient;
	readonly tools: ToolRegistry;
	readonly gate: TurnGate;
	readonly contracts: ContractCatalog;
	readonly admission: Admission;
	runOwnerTurn(input: OwnerTurnInput): Promise<OwnerTurnResult>;
}

export interface AgentServiceDeps {
	readonly config: Config;
	readonly db: Db;
	readonly log: FastifyBaseLogger;
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
	const contracts = makeContractCatalog({ config, log: deps.log });
	const tools = makeToolRegistry(
		[
			clarifyTool,
			memoryTool,
			sessionsListTool,
			sessionsReadTool,
			sessionSearchTool,
			skillsListTool,
			skillsSearchTool,
			skillsReadTool,
			skillsProposeTool
		],
		() => contracts.tools
	);
	const gate = makeTurnGate();
	const admission = makeAdmission(config, db, deps.log);

	async function runOwnerTurn(input: OwnerTurnInput): Promise<OwnerTurnResult> {
		const { principal } = input;
		// Admitted before anything else runs; the slot is held until the turn ends
		const decision = await admission.admit(principal.id);
		if (!decision.ok) return { kind: 'busy', reason: decision.reason };
		try {
			return await gate.run(principal.id, () => runAdmittedTurn(input));
		} finally {
			decision.release();
		}
	}

	async function runAdmittedTurn(input: OwnerTurnInput): Promise<OwnerTurnResult> {
		const { principal, target, message } = input;
		{
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
			const { session } = opened;
			const withheld =
				input.origin === 'event'
					? opened.actions.filter((action) => WITHHELD_FROM_EVENT_TURNS.includes(action))
					: [];
			const actions = opened.actions.filter((action) => !withheld.includes(action));
			const memory = actions.includes('memory.read_own')
				? await withPrincipal(db, principal, (tx) => listMemory(tx, principal.id))
				: { memory: [], user: [] };
			const skills = actions.includes('skills.read_own')
				? await withPrincipal(db, principal, (tx) => listSkills(tx))
				: [];
			const log = input.log.child({ session: session.id, principal: principal.id });
			log.info({ messageLength: message.length }, 'turn started');
			try {
				const turn = await runTurn(
					{ llm, tools, log, maxToolCalls: config.turn.maxToolCalls },
					{
						systemPrompt: buildSystemPrompt({
							persona:
								principal.id === ORGANIZATION_PRINCIPAL
									? organizationPrompt(config.org.name, config.org.persona)
									: DEFAULT_SYSTEM_PROMPT,
							memory,
							skills,
							history: session.messages,
							nudgeInterval: config.turn.memoryNudgeInterval
						}),
						history: session.messages,
						message,
						context: {
							principalId: principal.id,
							actions,
							withheldActions: withheld,
							db,
							...(input.correlationId === undefined ? {} : { correlationId: input.correlationId })
						}
					}
				);
				const saved = await withPrincipal(db, principal, (tx) =>
					saveSessionMessages(tx, session.id, turn.messages)
				);
				if (!saved) return { kind: 'missing' };
				await admission.recordUsage(principal.id, turn.tokens);
				log.info({ answerLength: turn.answer.length, tokens: turn.tokens }, 'turn finished');
				return { kind: 'ok', sessionId: session.id, answer: turn.answer, model: llm.model };
			} catch (err: unknown) {
				if (err instanceof TurnError || err instanceof LlmError) {
					log.error({ err }, 'turn failed');
					return { kind: 'failed', error: err.message };
				}
				throw err;
			}
		}
	}

	return { llm, tools, gate, contracts, admission, runOwnerTurn };
}
