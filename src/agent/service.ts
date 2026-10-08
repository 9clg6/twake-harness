import type { FastifyBaseLogger } from 'fastify';

import { localeOf } from '../assistants/locale.js';
import { findAssistant } from '../assistants/repository.js';
import type { Config } from '../config.js';
import { makeContractCatalog, type ContractCatalog } from '../contracts/catalog.js';
import { replayOutcome, type ConsentMetrics } from '../consents/metrics.js';
import {
	approvePendingCall,
	grantConsent,
	takeAllowedCall,
	markReplayed,
	supersedeApprovedCall,
	type ApprovedCall
} from '../consents/repository.js';
import { conversationText, type OwnerRequest } from '../consents/request.js';
import { withPrincipal, type Db } from '../db/client.js';
import { getMessages, type Messages } from '../i18n/messages.js';
import { DEFAULT_LEASE_MS } from '../jobs/worker.js';
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
import {
	carriesInvitation,
	checkAvailability,
	type Invitation,
	type ToolRunner
} from './invitation.js';
import { assistantPrompt, DEFAULT_SYSTEM_PROMPT, organizationPrompt } from './persona.js';
import { buildSystemPrompt } from './prompt.js';
import { listSkills } from '../skills/repository.js';
import {
	clarifyTool,
	consentsListTool,
	languageTool,
	makeConsentsWithdrawTool,
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
	WITHDRAW_OWN_CONSENTS,
	WRITE_OWN_MEMORY,
	WRITE_OWN_SETTINGS
} from './tools.js';

export type { TurnOrigin } from './tools.js';
import { runTurn, TurnError } from './turn.js';

export type SessionTarget =
	| { readonly kind: 'new' }
	| { readonly kind: 'id'; readonly id: string }
	| { readonly kind: 'room'; readonly roomId: string };

// What a turn an event started may not do, whatever its owner may: change how the assistant speaks
// to its owner, keep a note or a skill proposal that later turns would read as the assistant's own,
// or withdraw a consent. The event's own text comes from a third party, so only the owner, in a
// turn of their own, can make the assistant remember or change what they decided. Such a turn may
// prepare a write through a contract, which then waits for its owner's yes to the harness's own
// request, whatever they allowed.
const WITHHELD_FROM_EVENT_TURNS: readonly string[] = [
	WRITE_OWN_SETTINGS,
	WRITE_OWN_MEMORY,
	WITHDRAW_OWN_CONSENTS
];

// The harness's own question to an owner about a call it froze, on which the turn ends
interface Question {
	readonly text: string;
	// What the conversation keeps of it, for later turns of the model: the request without what an
	// application said of the call, which only its owner reads
	readonly kept: string;
	readonly pendingCallId: string;
	// Its parts, when the harness laid it out as a request about the call
	readonly request: OwnerRequest | null;
}

// The question a tool's outcome ends the turn on, when its call waits for its owner
function questionOf(outcome: ToolOutcome): Question | null {
	return outcome.final !== undefined && outcome.pendingCallId !== undefined
		? {
				text: outcome.final,
				kept: outcome.request === undefined ? outcome.final : conversationText(outcome.request),
				pendingCallId: outcome.pendingCallId,
				request: outcome.request ?? null
			}
		: null;
}

// What the model of a turn is told, and the harness's own question when a read it made before
// the model speaks waits for the owner
interface Told {
	readonly message: string | null;
	readonly question: Question | null;
}

// What the model reads when the contract its owner allowed is no longer offered as it was
const CONTRACT_CHANGED = {
	error: 'contract_changed',
	hint: 'The contract the owner allowed is no longer offered as it was, so nothing ran. Tell the owner.'
} as const;

// What came of the call its owner allowed: the call and its result, as the session keeps them;
// the harness's new question, when the call waits for its owner again; and the harness's own
// notice, when the call did not run as its owner allowed it: its contract refused it, as what it
// acts on changed since the preview its owner was shown, or, asked anew what the call would do,
// did it
interface Replayed {
	readonly messages: LlmMessage[];
	readonly question: Question | null;
	readonly notice: string | null;
	// Whether the call went to its contract: one no longer offered as its owner allowed it did not
	readonly ran: boolean;
}

// What a contract answers the call its owner allowed once they saw its preview, when what the call
// acts on changed since: nothing was done
const CHANGED_SINCE_PREVIEW = 409;

// Whether the contract refused the call its owner allowed, as what it acts on changed since the
// preview they were shown: the call carried that preview's digest, and the contract answered 409
function changedSincePreview(approved: ApprovedCall, outcome: ToolOutcome): boolean {
	return (
		approved.previewDigest !== null &&
		questionOf(outcome) === null &&
		statusOf(outcome.result) === CHANGED_SINCE_PREVIEW
	);
}

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
	// The event of a turn of origin event: its id and CloudEvent type, and for an invitation, what
	// the harness checks before the model speaks
	readonly event?: {
		readonly id: string;
		readonly type: string;
		readonly invitation?: Invitation | undefined;
	};
	// The call its owner just allowed: the turn runs it as frozen, then goes on from there, with
	// no new message
	readonly resume?: ResumeInput;
	// Told, after each action that does not end the turn, the actions it has done so far
	readonly actionsDone?: (actions: number) => void;
}

// How the owner allowed the call a turn resumes, which the consent it grants records: in the chat,
// or through the API. An answer in the chat, or through the API to a call asked in the room,
// approved the call before its job ran. A yes through the API to a call of a turn through the API
// is the answer itself, under its own id: the resumed turn takes the call as it starts, once
// admitted, so that the first answer wins and a turn refused for now leaves the call waiting.
export interface ResumeInput {
	readonly pendingCallId: string;
	readonly through: 'chat' | 'api';
	readonly answerId?: string;
}

export type OwnerTurnResult =
	| {
			readonly kind: 'ok';
			readonly sessionId: string;
			readonly answer: string;
			readonly model: string;
			// The call the harness froze, when the turn ended on its question to the owner
			readonly pendingCallId?: string;
			// That question in its parts, when the harness laid it out as a request about the call
			readonly request?: OwnerRequest;
			// The turn reached its limit of tool calls before it answered: there is more to do
			readonly atLimit?: true;
	  }
	| { readonly kind: 'forbidden' }
	| { readonly kind: 'missing' }
	// The call to resume no longer waited: another answer came first
	| { readonly kind: 'decided' }
	| { readonly kind: 'busy'; readonly reason: RefusalReason }
	| { readonly kind: 'failed'; readonly error: string };

export interface AgentService {
	readonly llm: LlmClient;
	readonly tools: ToolRegistry;
	readonly gate: TurnGate;
	readonly contracts: ContractCatalog;
	readonly admission: Admission;
	runOwnerTurn(input: OwnerTurnInput): Promise<OwnerTurnResult>;
	runAllowedCall(input: AllowedCallInput): Promise<AllowedCallResult>;
}

// A call a direct tool call through the API froze, which its owner allows through the API
export interface AllowedCallInput {
	readonly principal: Principal;
	readonly pendingCallId: string;
	// The owner's yes through the API, under its own id, which takes the call
	readonly answerId: string;
	readonly log: FastifyBaseLogger;
}

export type AllowedCallResult =
	| { readonly kind: 'ok'; readonly outcome: ToolOutcome }
	// The call no longer waited: another answer came first
	| { readonly kind: 'decided' };

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
			skillsProposeTool,
			consentsListTool,
			makeConsentsWithdrawTool({
				// Each application once, as consents_list names it
				applications: () => [...new Set(contracts.contracts.map((c) => c.domain))].sort(),
				consentMetrics
			})
		],
		() => contracts.tools
	);
	const gate = makeTurnGate();
	const admission = makeAdmission({ config, db, log: deps.log, clock });

	// What the model is told. An invitation an event brings has its slot checked by the harness
	// before the model speaks, from the UID and the times its wake-up carries, through the same
	// tools and context as the model's calls: what the calendar answered follows what the wake-up
	// told, as data. Any other message is told as it is. A read of that check that waits for its
	// owner, such as the first read of their calendar, ends the turn on the harness's question.
	async function messageFor(
		input: OwnerTurnInput,
		context: ToolContext,
		log: FastifyBaseLogger,
		messages: Messages
	): Promise<Told> {
		const event = input.origin === 'event' ? input.event : undefined;
		if (!carriesInvitation(event)) return { message: input.message, question: null };
		const { invitation } = event;
		let question: Question | null = null;
		const run: ToolRunner = async (name, args) => {
			const tool = tools.find(name);
			if (tool === null) return null;
			const outcome = await runTool(tool, args, context);
			question ??= questionOf(outcome);
			return outcome;
		};
		const check = await checkAvailability(run, invitation, { timeZone: config.timeZone });
		log.info({ freeBusyStatus: check.freeBusyStatus, reason: check.reason }, 'invitation checked');
		const availability = messages.events.availability(check.data);
		return {
			message: input.message === null ? availability : `${input.message}\n${availability}`,
			question
		};
	}

	// Runs the call its owner allowed, exactly as it was frozen. A tool that no longer stands for
	// the contract the owner allowed, at the same level, runs nothing. The call waits for nothing the
	// owner's yes answered; one that waits for its owner again, such as one the platform's broker
	// still refuses or one in an application whose writing they took back since, comes back with
	// the harness's new question. A call whose contract showed its owner what it would do carries
	// the digest of that preview, which the contract checks.
	async function runFrozenCall(
		approved: ApprovedCall,
		pendingCallId: string,
		context: ToolContext,
		log: FastifyBaseLogger
	): Promise<ToolOutcome> {
		const definition = contracts.contracts.find((c) => c.toolName === approved.tool);
		const tool = tools.find(approved.tool);
		const unchanged =
			definition !== undefined &&
			tool !== null &&
			definition.id === approved.contract &&
			definition.level === approved.level;
		const outcome: ToolOutcome = unchanged
			? await runTool(tool, approved.arguments, {
					...context,
					answeredReasons: approved.reasons,
					...(approved.previewDigest === null ? {} : { previewDigest: approved.previewDigest })
				})
			: { result: CONTRACT_CHANGED };
		const question = questionOf(outcome);
		const httpStatus = statusOf(outcome.result);
		const changed = changedSincePreview(approved, outcome);
		if (question === null) {
			consentMetrics.replayed(approved, replayOutcome(httpStatus));
			log.info(
				{
					pendingCallId,
					tool: approved.tool,
					status: unchanged ? toolCallStatus(outcome) : 'contract_changed',
					...(httpStatus === null ? {} : { httpStatus }),
					...(changed ? { changedSincePreview: true } : {})
				},
				'pending call replayed'
			);
		} else {
			// Its new request is what counts: it asks about everything that applies now
			log.info(
				{ pendingCallId, tool: approved.tool, nextPendingCallId: question.pendingCallId },
				'pending call waits again'
			);
		}
		return outcome;
	}

	// Runs the call its owner allowed, and writes it in the session as the assistant's call followed
	// by its result, for the model to go on from, with the harness's new question when it waits
	// again, or its own notice when the call did not run as its owner allowed it
	async function replay(
		approved: ApprovedCall,
		pendingCallId: string,
		context: ToolContext,
		log: FastifyBaseLogger,
		consent: Messages['consent']
	): Promise<Replayed> {
		const outcome = await runFrozenCall(approved, pendingCallId, context, log);
		const question = questionOf(outcome);
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
			question,
			// A call that did not run as its owner allowed it ends the turn on the harness's notice:
			// one its contract refused, as what it acts on changed since the preview they were shown,
			// or one a preview asked for anew did, which the tool's outcome carries without a question
			notice: changedSincePreview(approved, outcome)
				? consent.changed
				: question === null
					? (outcome.final ?? null)
					: null,
			ran: outcome.result !== CONTRACT_CHANGED
		};
	}

	// A call a direct tool call froze has no turn to go on with: once its owner allowed it through
	// the API, it runs as it was frozen, under the correlation id of the request that froze it, if
	// it still waited, or if an earlier yes left it unrun past the lease
	async function runAllowedCall(input: AllowedCallInput): Promise<AllowedCallResult> {
		const { principal, pendingCallId, answerId, log } = input;
		const opened = await withPrincipal(db, principal, async (tx) => {
			const record = await ensurePrincipal(tx, principal);
			const approved = await takeAllowedCall(
				tx,
				principal.id,
				pendingCallId,
				answerId,
				DEFAULT_LEASE_MS
			);
			if (approved === null) return null;
			// As in a turn: a yes to a first use allows the application from now on, a yes to the
			// broker's request grants nothing
			if (approved.reasons.includes('consent')) {
				await grantConsent(tx, principal.id, approved.domain, approved.level, 'api');
			}
			return { actions: record.actions, approved };
		});
		if (opened === null) return { kind: 'decided' };
		const { actions, approved } = opened;
		const outcome = await runFrozenCall(
			approved,
			pendingCallId,
			{
				principalId: principal.id,
				origin: approved.origin,
				actions,
				db,
				...(approved.correlationId === null ? {} : { correlationId: approved.correlationId }),
				log
			},
			log
		);
		// A call that waits for its owner again is not stamped as run: its newer request supersedes
		// the one answered
		await withPrincipal(db, principal, (tx) =>
			questionOf(outcome) === null
				? markReplayed(tx, pendingCallId)
				: supersedeApprovedCall(tx, principal.id, pendingCallId)
		);
		return { kind: 'ok', outcome };
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
					const { pendingCallId, through, answerId } = input.resume;
					approved =
						answerId === undefined
							? await approvePendingCall(tx, principal.id, pendingCallId)
							: await takeAllowedCall(tx, principal.id, pendingCallId, answerId, DEFAULT_LEASE_MS);
					if (approved === null) {
						return answerId === undefined
							? { kind: 'missing' as const }
							: { kind: 'decided' as const };
					}
					if (approved.reasons.includes('consent')) {
						await grantConsent(tx, principal.id, approved.domain, approved.level, through);
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
			// A resumed turn may do no more than the turn that froze its call. Resumed from a call that
			// a turn an event started prepared, it is still that event's: the owner's yes runs that
			// call alone, and any other write it prepares waits for them again.
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
				...(correlationId === undefined ? {} : { correlationId }),
				sessionId: session.id,
				log
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
					{ role: 'assistant', content: told.question.kept }
				];
				const saved = await withPrincipal(db, principal, (tx) =>
					saveSessionMessages(tx, session.id, asked)
				);
				if (!saved) return { kind: 'missing' };
				const { pendingCallId, request } = told.question;
				log.info({ pendingCallId }, 'turn stopped on a question to the owner');
				return {
					kind: 'ok',
					sessionId: session.id,
					answer: told.question.text,
					model: llm.model,
					pendingCallId,
					...(request === null ? {} : { request })
				};
			}
			// Read at the start of every turn, never kept: a session can span days
			const moment = describeMoment(clock.now(), config.timeZone, locale);
			let history: readonly LlmMessage[] = session.messages;
			// The call its owner allowed counts among the actions of the turn it resumes
			let actionsBefore = 0;
			if (approved !== null && input.resume !== undefined) {
				const { pendingCallId } = input.resume;
				const replayed = await replay(approved, pendingCallId, context, log, messages.consent);
				if (replayed.ran) actionsBefore = 1;
				// A call that waits for its owner again ends the turn on the harness's new question,
				// which the conversation keeps as the assistant's answer: the owner's next yes tries it
				// once more, never the model
				const newQuestion = replayed.question;
				// A call that did not run as its owner allowed it ends the turn on the harness's own
				// notice: the owner learns it from the harness, never from the model, which reads the
				// call, its result and the notice in the conversation
				const { notice } = replayed;
				history = [
					...history,
					...replayed.messages,
					...(newQuestion === null
						? []
						: [{ role: 'assistant' as const, content: newQuestion.kept }]),
					...(notice === null ? [] : [{ role: 'assistant' as const, content: notice }])
				];
				// The conversation holds the call at once, whatever happens to the rest of the turn. A
				// call that waits again is not stamped as run: the newer request supersedes the one
				// answered.
				const kept = history;
				await withPrincipal(db, principal, async (tx) => {
					await saveSessionMessages(tx, session.id, kept);
					if (newQuestion === null) await markReplayed(tx, pendingCallId);
					else await supersedeApprovedCall(tx, principal.id, pendingCallId);
				});
				if (newQuestion !== null) {
					log.info(
						{ pendingCallId: newQuestion.pendingCallId },
						'turn stopped on a question to the owner'
					);
					return {
						kind: 'ok',
						sessionId: session.id,
						answer: newQuestion.text,
						model: llm.model,
						pendingCallId: newQuestion.pendingCallId,
						...(newQuestion.request === null ? {} : { request: newQuestion.request })
					};
				}
				if (notice !== null) {
					log.info({ pendingCallId }, 'turn stopped on a notice to the owner');
					return { kind: 'ok', sessionId: session.id, answer: notice, model: llm.model };
				}
			}
			// The call its owner allowed is the first action of the turn that goes on from it
			if (actionsBefore > 0) input.actionsDone?.(actionsBefore);
			try {
				const turn = await runTurn(
					{
						llm,
						tools,
						log,
						maxToolCalls: config.turn.maxToolCalls,
						historyMaxChars: config.turn.historyMaxChars
					},
					{
						systemPrompt: buildSystemPrompt({
							persona:
								principal.id === ORGANIZATION_PRINCIPAL
									? withAddressing(
											organizationPrompt(config.org.name, config.org.persona),
											messages
										)
									: withLanguage(
											input.assistantName === undefined
												? DEFAULT_SYSTEM_PROMPT
												: assistantPrompt(input.assistantName),
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
						context,
						actionsBefore,
						limitNotice: (actions) => messages.notices.callLimit(actions),
						...(input.actionsDone === undefined ? {} : { actionsDone: input.actionsDone })
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
					...(turn.pendingCallId === undefined ? {} : { pendingCallId: turn.pendingCallId }),
					...(turn.request === undefined ? {} : { request: turn.request }),
					...(turn.atLimit === true ? { atLimit: true } : {})
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

	return { llm, tools, gate, contracts, admission, runOwnerTurn, runAllowedCall };
}
