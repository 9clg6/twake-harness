import type { FastifyBaseLogger } from 'fastify';

import { localeOf } from '../assistants/locale.js';
import { findAssistant } from '../assistants/repository.js';
import type { Config } from '../config.js';
import { makeContractCatalog, type ContractCatalog } from '../contracts/catalog.js';
import { replayOutcome, type ConsentMetrics } from '../consents/metrics.js';
import {
	approvePendingCall,
	grantConsent,
	markReplayed,
	type ApprovedCall
} from '../consents/repository.js';
import { ACT_THROUGH_CONTRACTS } from '../contracts/tools.js';
import { withPrincipal, type Db } from '../db/client.js';
import { getMessages, type Messages } from '../i18n/messages.js';
import { LlmError, makeLlmClient, type LlmClient, type LlmMessage } from '../llm/client.js';
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
import { describeMoment, SYSTEM_CLOCK, type Clock } from './clock.js';
import { makeTurnGate, type TurnGate } from './gate.js';
import { checkInvitation, isInvitationEvent, type ToolRunner } from './invitation.js';
import { assistantPrompt, DEFAULT_SYSTEM_PROMPT, organizationPrompt } from './persona.js';
import { buildSystemPrompt } from './prompt.js';
import { listSkills } from '../skills/repository.js';
import {
	clarifyTool,
	languageTool,
	makeToolRegistry,
	memoryTool,
	runTool,
	toolCallStatus,
	sessionSearchTool,
	sessionsListTool,
	sessionsReadTool,
	skillsListTool,
	skillsProposeTool,
	skillsReadTool,
	skillsSearchTool,
	type ToolContext,
	type ToolOutcome,
	type ToolRegistry,
	type TurnOrigin,
	WRITE_OWN_MEMORY,
	WRITE_OWN_SETTINGS
} from './tools.js';

export type { TurnOrigin } from './tools.js';
import { runTurn, TurnError } from './turn.js';

export type SessionTarget =
	| { readonly kind: 'new' }
	| { readonly kind: 'id'; readonly id: string }
	| { readonly kind: 'room'; readonly roomId: string };

// What a turn an event started may not do, whatever its owner may: act through a contract, change
// how the assistant speaks to its owner, or keep a note or a skill proposal that later turns would
// read as the assistant's own. The event's own text comes from a third party, so only the owner's
// yes, in a turn of their own, can make the assistant act or remember.
const WITHHELD_FROM_EVENT_TURNS: readonly string[] = [
	ACT_THROUGH_CONTRACTS,
	WRITE_OWN_SETTINGS,
	WRITE_OWN_MEMORY
];

// What the model of a turn is told, and the harness's own question when a read it made before
// the model speaks waits for the owner
interface Told {
	readonly message: string | null;
	readonly question: { readonly text: string; readonly pendingCallId: string } | null;
}

// What the model reads when the contract its owner allowed is no longer offered as it was
const CONTRACT_CHANGED = {
	error: 'contract_changed',
	hint: 'The contract the owner allowed is no longer offered as it was, so nothing ran. Tell the owner.'
} as const;

// The HTTP status a contract answered with, when the result carries one
function statusOf(result: unknown): number | null {
	if (typeof result !== 'object' || result === null) return null;
	const status = (result as Record<string, unknown>)['status'];
	return typeof status === 'number' ? status : null;
}

export interface OwnerTurnInput {
	readonly principal: Principal;
	readonly target: SessionTarget;
	// The owner's message, or null when the turn resumes from a call its owner allowed
	readonly message: string | null;
	readonly log: FastifyBaseLogger;
	// What links the turn's calls in the audit: the request id, or the Matrix event id
	readonly correlationId?: string;
	// The owner unless told otherwise
	readonly origin?: TurnOrigin;
	// The name the owner gave the assistant answering in this turn, when there is one
	readonly assistantName?: string;
	// The event a dispatcher posted, for a turn of origin event: its id and CloudEvent type
	readonly event?: { readonly id: string; readonly type: string };
	// The call its owner just allowed: the turn runs it as frozen, then goes on from there, with
	// no new message
	readonly resume?: { readonly pendingCallId: string };
}

export type OwnerTurnResult =
	| {
			readonly kind: 'ok';
			readonly sessionId: string;
			readonly answer: string;
			readonly model: string;
			// The call the harness froze, when the turn ended on its question to the owner
			readonly pendingCallId?: string;
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
	readonly clock?: Clock;
	// Where its role counts the calls it freezes and those it replays
	readonly consentMetrics: ConsentMetrics;
}

export function makeAgentService(deps: AgentServiceDeps): AgentService {
	const { config, db } = deps;
	const clock = deps.clock ?? SYSTEM_CLOCK;
	// The persona's rules are in English; how to address people is told in the language the model
	// speaks, when that language marks it
	const withAddressing = (persona: string, messages: Messages): string =>
		messages.addressing === null ? persona : `${persona} ${messages.addressing}`;
	// An owner's assistant is told, in its owner's language, to speak it; the organization agent
	// answers each member in their own language, as it always did
	const withLanguage = (persona: string, messages: Messages): string =>
		withAddressing(`${persona} ${messages.language.speak}`, messages);
	// The owner's own assistant may need an invitation the conversation does not hold; the
	// organization agent has no calendar of its own to search
	const withLookup = (persona: string, messages: Messages): string =>
		`${persona} ${messages.lookup}`;
	const llm =
		deps.llm ??
		makeLlmClient({
			baseUrl: config.apisix.baseUrl,
			consumerKey: config.apisix.consumerKey,
			model: config.llm.model,
			maxTokens: config.llm.maxTokens,
			timeoutMs: config.llm.timeoutMs
		});
	const { consentMetrics } = deps;
	const contracts = makeContractCatalog({ config, log: deps.log, consentMetrics });
	const tools = makeToolRegistry(
		[
			clarifyTool,
			memoryTool,
			languageTool,
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

	// What the model is told. An invitation an event brings is read and its slot checked by the
	// harness before the model speaks, through the same tools and context as the model's calls,
	// and handed to it as data; any other message is told as it is. A read of that check that
	// waits for its owner, such as the first read of their calendar, ends the turn on the
	// harness's question.
	async function messageFor(
		input: OwnerTurnInput,
		context: ToolContext,
		log: FastifyBaseLogger,
		messages: Messages
	): Promise<Told> {
		const event = input.event;
		if (input.origin !== 'event' || event === undefined || !isInvitationEvent(event.type)) {
			return { message: input.message, question: null };
		}
		let question: Told['question'] = null;
		const run: ToolRunner = async (name, args) => {
			const tool = tools.find(name);
			if (tool === null) return null;
			const outcome = await runTool(tool, args, context);
			if (question === null && outcome.final !== undefined && outcome.pendingCallId !== undefined) {
				question = { text: outcome.final, pendingCallId: outcome.pendingCallId };
			}
			return outcome;
		};
		const check = await checkInvitation(run, event.id, { timeZone: config.timeZone });
		log.info(
			{
				eventStatus: check.eventStatus,
				freeBusyStatus: check.freeBusyStatus,
				reason: check.reason
			},
			'invitation checked'
		);
		return { message: messages.events.invitation(event.id, check.data), question };
	}

	// Runs the call its owner allowed, exactly as it was frozen, and writes it in the session as
	// the assistant's call followed by its result, for the model to go on from. A tool that no
	// longer stands for the contract the owner allowed, at the same level, runs nothing. A call
	// that waits for its owner again, such as one the platform's broker still refuses, comes back
	// with the harness's new question.
	async function replay(
		approved: ApprovedCall,
		pendingCallId: string,
		context: ToolContext,
		log: FastifyBaseLogger
	): Promise<{ readonly messages: LlmMessage[]; readonly question: Told['question'] }> {
		const definition = contracts.contracts.find((c) => c.toolName === approved.tool);
		const tool = tools.find(approved.tool);
		const unchanged =
			definition !== undefined &&
			tool !== null &&
			definition.id === approved.contract &&
			definition.level === approved.level;
		const outcome: ToolOutcome = unchanged
			? await runTool(tool, approved.arguments, context)
			: { result: CONTRACT_CHANGED };
		const httpStatus = statusOf(outcome.result);
		consentMetrics.replayed(approved, replayOutcome(httpStatus));
		log.info(
			{
				pendingCallId,
				tool: approved.tool,
				status: unchanged ? toolCallStatus(outcome) : 'contract_changed',
				...(httpStatus === null ? {} : { httpStatus })
			},
			'pending call replayed'
		);
		const callId = `replay_${pendingCallId}`;
		return {
			messages: [
				{
					role: 'assistant',
					content: null,
					tool_calls: [
						{
							id: callId,
							type: 'function',
							function: { name: approved.tool, arguments: JSON.stringify(approved.arguments) }
						}
					]
				},
				{
					role: 'tool',
					tool_call_id: callId,
					name: approved.tool,
					content: JSON.stringify(outcome.result)
				}
			],
			question:
				outcome.final !== undefined && outcome.pendingCallId !== undefined
					? { text: outcome.final, pendingCallId: outcome.pendingCallId }
					: null
		};
	}

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
		const { principal, target } = input;
		{
			// A short transaction settles rights and the session; the model call runs outside it.
			const opened = await withPrincipal(db, principal, async (tx) => {
				const record = await ensurePrincipal(tx, principal);
				if (!record.actions.includes('chat')) return { kind: 'forbidden' as const };
				// The owner's answer approves the call once. Asked about a first use, it also lets the
				// assistant use that application at that level from now on; asked to try again once
				// the platform has their permission, it allows nothing more.
				let approved: ApprovedCall | null = null;
				if (input.resume !== undefined) {
					approved = await approvePendingCall(tx, principal.id, input.resume.pendingCallId);
					if (approved === null) return { kind: 'missing' as const };
					if (approved.reasons.includes('consent')) {
						await grantConsent(tx, principal.id, approved.domain, approved.level, 'chat');
					}
				}
				const locale = localeOf(await findAssistant(tx, principal.id), config.locale);
				let session: SessionRecord | null;
				if (target.kind === 'new') session = await createSession(tx, principal.id);
				else if (target.kind === 'room')
					session = await ensureRoomSession(tx, principal.id, target.roomId);
				else session = await findSession(tx, target.id);
				return session === null
					? { kind: 'missing' as const }
					: { kind: 'ok' as const, session, actions: record.actions, approved, locale };
			});
			if (opened.kind !== 'ok') return opened;
			const { session, approved, locale } = opened;
			const messages = getMessages(locale);
			// A resumed turn may do no more than the turn that froze its call
			const origin = approved?.origin ?? input.origin;
			const withheld =
				origin === 'event'
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
			// A resumed turn keeps the correlation id of the turn that froze its call, so that the
			// gateway's audit links both
			const correlationId = approved?.correlationId ?? input.correlationId;
			const context: ToolContext = {
				principalId: principal.id,
				...(origin === undefined ? {} : { origin }),
				actions,
				withheldActions: withheld,
				db,
				...(correlationId === undefined ? {} : { correlationId })
			};
			// A resumed turn has no new message: it goes on from the call its owner allowed
			const told: Told =
				approved === null
					? await messageFor(input, context, log, messages)
					: { message: null, question: null };
			log.info({ messageLength: told.message?.length ?? 0 }, 'turn started');
			if (told.question !== null) {
				// The conversation keeps what the model would have been told, for the turn the
				// owner's answer resumes
				const asked: LlmMessage[] = [
					...session.messages,
					{ role: 'user', content: told.message },
					{ role: 'assistant', content: told.question.text }
				];
				const saved = await withPrincipal(db, principal, (tx) =>
					saveSessionMessages(tx, session.id, asked)
				);
				if (!saved) return { kind: 'missing' };
				const { pendingCallId } = told.question;
				log.info({ pendingCallId }, 'turn stopped on a question to the owner');
				return {
					kind: 'ok',
					sessionId: session.id,
					answer: told.question.text,
					model: llm.model,
					pendingCallId
				};
			}
			// Read at the start of every turn, never kept: a session can span days
			const moment = describeMoment(clock.now(), config.timeZone, locale);
			let history: readonly LlmMessage[] = session.messages;
			if (approved !== null && input.resume !== undefined) {
				const { pendingCallId } = input.resume;
				const replayed = await replay(approved, pendingCallId, context, log);
				// A call that waits for its owner again ends the turn on the harness's new question,
				// which the conversation keeps as the assistant's answer: the owner's next yes tries it
				// once more, never the model
				const asked = replayed.question;
				history = [
					...history,
					...replayed.messages,
					...(asked === null ? [] : [{ role: 'assistant' as const, content: asked.text }])
				];
				// The conversation holds the call at once, whatever happens to the rest of the turn
				const kept = history;
				await withPrincipal(db, principal, async (tx) => {
					await saveSessionMessages(tx, session.id, kept);
					await markReplayed(tx, pendingCallId);
				});
				if (asked !== null) {
					log.info(
						{ pendingCallId: asked.pendingCallId },
						'turn stopped on a question to the owner'
					);
					return {
						kind: 'ok',
						sessionId: session.id,
						answer: asked.text,
						model: llm.model,
						pendingCallId: asked.pendingCallId
					};
				}
			}
			try {
				const turn = await runTurn(
					{ llm, tools, log, maxToolCalls: config.turn.maxToolCalls },
					{
						systemPrompt: buildSystemPrompt({
							persona:
								principal.id === ORGANIZATION_PRINCIPAL
									? withAddressing(
											organizationPrompt(config.org.name, config.org.persona),
											messages
										)
									: withLanguage(
											withLookup(
												input.assistantName === undefined
													? DEFAULT_SYSTEM_PROMPT
													: assistantPrompt(input.assistantName),
												messages
											),
											messages
										),
							moment: messages.now(moment.words, moment.iso, moment.timeZone),
							memory,
							skills,
							history,
							nudgeInterval: config.turn.memoryNudgeInterval
						}),
						history,
						message: told.message,
						context
					}
				);
				const saved = await withPrincipal(db, principal, (tx) =>
					saveSessionMessages(tx, session.id, turn.messages)
				);
				if (!saved) return { kind: 'missing' };
				await admission.recordUsage(principal.id, turn.tokens);
				log.info({ answerLength: turn.answer.length, tokens: turn.tokens }, 'turn finished');
				return {
					kind: 'ok',
					sessionId: session.id,
					answer: turn.answer,
					model: llm.model,
					...(turn.pendingCallId === undefined ? {} : { pendingCallId: turn.pendingCallId })
				};
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
