import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { FastifyBaseLogger } from 'fastify';

import type { Locale } from '../i18n/messages.js';

import {
	LlmError,
	type LlmCallOptions,
	type LlmClient,
	type LlmCompletion,
	type LlmMessage,
	type LlmToolCall,
	type LlmToolDefinition
} from '../llm/client.js';
import { conversationText, type OwnerRequest } from '../consents/request.js';
import { withoutCallMarkup } from './call-markup.js';
import {
	checkPrompt,
	isConcerned,
	readClaims,
	readSort,
	sentencesOf,
	sortRequest,
	withoutSentences
} from './verify.js';
import {
	laneOf,
	readProbabilities,
	REFUSE_THRESHOLD,
	routeRequest,
	WRITE_THRESHOLD,
	type Capability,
	type Lane
} from './route.js';
import { computeMessageSize, computeVisibleHistory } from './history.js';
import {
	describeCall,
	markDone,
	PLAN_GUIDANCE,
	PLAN_TOOL,
	planDefinition,
	planFromHistory,
	planInstruction,
	stepBefore,
	readPlan,
	undoneSteps,
	withAction,
	type PlanStep,
	type ToolCatalog
} from './plan.js';
import {
	runTool,
	toolCallStatus,
	type ToolCallStatus,
	type ToolContext,
	type ToolRegistry
} from './tools.js';

export interface TurnInput {
	readonly systemPrompt: string;
	readonly history: readonly LlmMessage[];
	// The owner's new message, or null when the turn goes on from its history, such as after a
	// call its owner allowed
	readonly message: string | null;
	readonly context: ToolContext;
	// The language the owner reads, in which the sentences of an answer are told apart
	readonly locale: Locale;
	// The time zone the owner reads an instant in
	readonly timeZone: string;
	// The actions the turn did before the model spoke: the call its owner allowed, when it resumes
	// from one
	readonly actionsBefore: number;
	// What the owner reads, in their language, when the model answers the limit of tool calls with
	// no words for them: given the actions the turn did, what was done and how to have it go on
	limitNotice(actions: number): string;
	// What the owner reads, in their language, below an answer the model gave while steps of its
	// plan were not done: those steps, as the model wrote them
	stepsNotice(steps: readonly string[]): string;
	// What the owner reads, in their language, below an answer, of what was done for them in an
	// application: the harness says it from the result of each call, never the model
	doneNotice(steps: readonly string[]): string;
	// What the owner reads below an answer that says something was done, in a turn that did nothing
	// for them in an application
	nothingDoneNotice(): string;
	// What the platform holds of the owner's events, read by the harness itself to check an answer
	// against, or null when it may not read them without asking
	ownerEvents(): Promise<LlmMessage | null>;
}

export interface TurnOutput {
	readonly answer: string;
	readonly messages: readonly LlmMessage[];
	readonly tokens: number;
	// The call the harness froze, when the turn ended on its question to the owner
	readonly pendingCallId?: string;
	// That question in its parts, when the harness laid it out as a request about the call
	readonly request?: OwnerRequest;
}

export interface TurnDeps {
	readonly llm: LlmClient;
	readonly tools: ToolRegistry;
	readonly log: FastifyBaseLogger;
	readonly maxToolCalls: number;
	// The most characters of the past conversation the model reads; its stored history keeps all
	readonly historyMaxChars: number;
	// Whether the model may plan a request in steps, which the harness then holds it to
	readonly planning: boolean;
	// The model that checks an answer, sentence by sentence
	readonly checkModel: string;
	// The decision model that sorts the answers worth a check, or empty when there is none
	readonly sortModel: string;
	// What the assistant can do in its owner's applications, reads before writes: what a decision
	// model sorts a message among
	capabilities(): readonly Capability[];
	// What a tool does for the owner in an application, as they read it, or null when it only
	// reads: with planning on, such a call is always a step of the plan, planned by the model or not
	action(tool: string): string | null;
}

export class TurnError extends Error {
	override readonly name = 'TurnError';
}

// The size of a prompt, which the info logs report instead of its text
function countCharacters(messages: readonly LlmMessage[]): number {
	let total = 0;
	for (const message of messages) total += computeMessageSize(message);
	return total;
}

// What the model reads for a call it made after one that ended the turn
const NOT_RUN = {
	error: 'not_run',
	hint: 'The turn stopped before this call ran. Make it again if it is still needed.'
} as const;

// What the model reads for a write the owner's message does not ask for
const NOT_ASKED = {
	error: 'not_asked',
	hint: "This call did not run: the user's message does not ask for it. Tell them what you could do, and let them ask for it."
} as const;

// What the model reads for a call it made once its turn had run all the calls one message may
function limitReached(limit: number): { readonly error: string; readonly hint: string } {
	return {
		error: 'tool_call_limit',
		hint: `This call did not run: the limit of ${limit} tool calls for one message is reached.`
	};
}

// What the model is told when it is asked for the answer that ends a turn whose message reached
// its limit of tool calls, with no tool left to call: the owner learns where things stand, and
// that they can have it go on
function wrapUpInstruction(limit: number): string {
	return `You reached the limit of ${limit} tool calls for one message, so the calls you made past it did not run, and no tool is available now. Answer the user now: tell them what you did, what remains to be done, and that they can ask you to continue.`;
}

// The most one model call may spend: a call that ran out is retried once at twice the budget,
// up to this
export const MAX_RETRY_TOKENS = 32_768;

function usedTokens(completion: LlmCompletion): number {
	return (completion.usage?.promptTokens ?? 0) + (completion.usage?.completionTokens ?? 0);
}

// A reasoning model can spend its whole budget deliberating and stop before it writes a word: the
// reasoning is stripped, so nothing visible is left
function ranOutOfBudget(completion: LlmCompletion): boolean {
	return (
		completion.finishReason === 'length' &&
		(completion.content ?? '').length === 0 &&
		completion.toolCalls.length === 0
	);
}

// Logging only: the metadata at info, the conversation itself at debug
function logAnswer(log: FastifyBaseLogger, iteration: number, completion: LlmCompletion): void {
	log.info(
		{
			iteration,
			finishReason: completion.finishReason,
			usage: completion.usage,
			toolNames: completion.toolCalls.map((call) => call.function.name),
			answerLength: completion.content?.length ?? 0,
			hasReasoning: completion.reasoning !== null && completion.reasoning.length > 0
		},
		'model answered'
	);
	log.debug(
		{
			iteration,
			content: completion.content,
			reasoning: completion.reasoning,
			toolCalls: completion.toolCalls,
			finishReason: completion.finishReason,
			usage: completion.usage
		},
		'model answered'
	);
}

// The answers of calls the model made that never run, each telling it why: strict model APIs refuse
// a history with a call left unanswered
function skippedAnswers(calls: readonly LlmToolCall[], result: unknown): LlmMessage[] {
	return calls.map((call): LlmMessage => ({
		role: 'tool',
		tool_call_id: call.id,
		name: call.function.name,
		content: JSON.stringify(result)
	}));
}

function parseArguments(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

interface Asked {
	readonly completion: LlmCompletion;
	readonly tokens: number;
}

// One model call, with the tools it may call: a call that ran out of budget while thinking is made
// once more with twice the budget, up to the ceiling
async function askModel(
	deps: TurnDeps,
	iteration: number,
	prompt: readonly LlmMessage[],
	tools: readonly LlmToolDefinition[],
	options: LlmCallOptions = {}
): Promise<Asked> {
	deps.log.info(
		{ iteration, messageCount: prompt.length, characters: countCharacters(prompt) },
		'model asked'
	);
	deps.log.debug({ iteration, messages: prompt }, 'model asked');
	let completion = await deps.llm.complete(prompt, tools, options);
	let tokens = usedTokens(completion);
	logAnswer(deps.log, iteration, completion);
	if (ranOutOfBudget(completion)) {
		const budget = deps.llm.maxTokens;
		const retryBudget = Math.min(budget * 2, MAX_RETRY_TOKENS);
		// Already at the ceiling, a second call would end the same way
		if (retryBudget > budget) {
			deps.log.info(
				{ iteration, budget, retryBudget, usage: completion.usage },
				'model ran out of budget'
			);
			completion = await deps.llm.complete(prompt, tools, { ...options, maxTokens: retryBudget });
			tokens += usedTokens(completion);
			logAnswer(deps.log, iteration, completion);
		}
	}
	return { completion, tokens };
}

// The model's words to its owner, without the calls it wrote in its text rather than made: a model
// that wrote nothing else answered nothing
function wordsOf(completion: LlmCompletion): string {
	const words = withoutCallMarkup(answerOf(completion));
	if (words.length === 0) throw new TurnError('the model answered nothing');
	return words;
}

// The model's answer to its owner, which ends the turn
function answerOf(completion: LlmCompletion): string {
	const answer = completion.content ?? '';
	if (answer.length === 0) throw new TurnError('the model answered nothing');
	return answer;
}

// What a turn carries from one step of its graph to the next
const TurnState = Annotation.Root({
	// What this turn adds to the conversation, which the model always reads whole
	messages: Annotation<LlmMessage[]>({
		reducer: (kept, added) => [...kept, ...added],
		default: () => []
	}),
	toolCalls: Annotation<number>(),
	// The calls that reached their tool, and those of the turn before the model spoke
	actions: Annotation<number>(),
	tokens: Annotation<number>({ reducer: (spent, more) => spent + more, default: () => 0 }),
	iteration: Annotation<number>(),
	// The calls the model made past the limit of the message, which never run
	notRun: Annotation<number>(),
	// The steps the model planned, each marked done by the harness from the result of its call
	plan: Annotation<readonly PlanStep[] | null>(),
	// Whether the model was already sent back to steps it left undone
	nudged: Annotation<boolean>(),
	// How likely the owner's message asks for each thing the assistant can do, as a decision model
	// read it, or null when none read it
	asked: Annotation<Readonly<Record<string, number>> | null>(),
	// Where the decision model sent the turn, or null when none sorted its message: the model then
	// has every tool and plans by itself
	lane: Annotation<Lane | null>(),
	// The capabilities the turn may use in its lane, by their names
	named: Annotation<readonly string[]>(),
	// Whether the answer says something was done for the owner, in a turn that did nothing
	unfounded: Annotation<boolean>(),
	// What the model answered without a call, before the harness checked it against the plan
	draft: Annotation<string | null>(),
	// What the owner reads, once a step ended the turn
	answer: Annotation<string | null>(),
	pendingCallId: Annotation<string | undefined>(),
	request: Annotation<OwnerRequest | undefined>()
});

type TurnStep = typeof TurnState.State;
type TurnUpdate = typeof TurnState.Update;

// One turn, as a graph the harness walks: the model answers, possibly through tool calls, within a
// bounded number of calls. Which step comes next is decided here, from what the last one did, never
// by the model: its calls go to their tools, a call that waits for its owner ends the turn on the
// harness's question, and a model that goes past the limit is asked once more, without tools, to
// tell its owner where things stand; should it write no words for them, the harness tells them
// itself what was done, so that the turn ends on an answer whatever the model writes. A model that
// planned its request in steps is held to them: the harness marks a step done from the result of
// its call, sends the model back once to those it left, and tells the owner itself which ones stay
// undone. The graph keeps no checkpoint: a call that waits for its owner is frozen in the
// database, and the turn their answer resumes is a new walk, which reads its plan back from the
// conversation. Every model call and every tool call
// is logged at info with its metadata only. The conversation itself (prompt, answer, reasoning,
// tool arguments and results) goes to debug: messages reach the harness end-to-end encrypted and
// are decrypted only here, so their text must stay out of the production logs.
export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<TurnOutput> {
	const past = computeVisibleHistory(input.history, deps.historyMaxChars);
	if (past.length < input.history.length) {
		deps.log.info(
			{ historyMessages: input.history.length, shownMessages: past.length },
			'history windowed'
		);
	}
	const systemFor = (state: TurnStep, more?: string): LlmMessage => ({
		role: 'system',
		content: [
			input.systemPrompt,
			...(state.plan !== null
				? [planInstruction(state.plan, state.nudged)]
				: deps.planning && state.lane === null
					? [PLAN_GUIDANCE]
					: []),
			...(more === undefined ? [] : [more])
		].join('\n\n')
	});

	const catalog: ToolCatalog = {
		describe: (name) =>
			deps.tools.find(name) === null
				? null
				: (deps.action(name) ?? deps.tools.find(name)?.definition.function.description ?? null),
		isAction: (name) => deps.action(name) !== null,
		detail: (args) => describeCall(args, input.locale, input.timeZone)
	};

	// What the owner's message asks for, told by a decision model before the assistant's model
	// reads it: the capabilities it names become the plan of the turn, which the model is then held
	// to. The plan is written in the conversation as a plan the assistant made, so that the turn an
	// owner's answer resumes reads it back. A sorting that fails leaves the turn to the model.
	async function route(): Promise<TurnUpdate> {
		const capabilities = deps.capabilities();
		if (capabilities.length === 0 || input.message === null) return {};
		try {
			const started = performance.now();
			const sorted = await deps.llm.complete(routeRequest(capabilities, past, input.message), [], {
				model: deps.sortModel
			});
			const tokens = usedTokens(sorted);
			const given = readProbabilities(sorted.content);
			const durationMs = Math.round(performance.now() - started);
			if (given === null) {
				deps.log.info({ lane: null, durationMs }, 'message routed');
				return { tokens };
			}
			const { lane, named } = laneOf(given, capabilities);
			const sent = {
				tokens,
				lane,
				named: named.map((capability) => capability.name),
				asked: Object.fromEntries(given)
			};
			deps.log.info({ lane, tools: sent.named, durationMs }, 'message routed');
			if (named.length === 0) return sent;
			const steps = named.map((capability) => ({
				what: deps.action(capability.name) ?? capability.description,
				tool: capability.name
			}));
			const id = `route_${input.history.length}`;
			return {
				...sent,
				plan: steps.map((step) => ({ ...step, done: false })),
				messages: [
					{
						role: 'assistant',
						content: null,
						tool_calls: [
							{
								id,
								type: 'function',
								function: { name: PLAN_TOOL, arguments: JSON.stringify({ steps }) }
							}
						]
					},
					{
						role: 'tool',
						tool_call_id: id,
						name: PLAN_TOOL,
						content: JSON.stringify({ planned: steps.length })
					}
				]
			};
		} catch (err: unknown) {
			if (!(err instanceof LlmError)) throw err;
			deps.log.warn({ err }, 'message not routed');
			return {};
		}
	}

	// One answer of the model, to a prompt and with the tools the step gives it
	async function answer(
		state: TurnStep,
		system: LlmMessage,
		offered: readonly LlmToolDefinition[]
	): Promise<TurnUpdate> {
		const { completion, tokens } = await askModel(
			deps,
			state.iteration,
			[system, ...past, ...state.messages],
			offered
		);
		if (completion.toolCalls.length === 0) return { tokens, draft: wordsOf(completion) };
		return {
			tokens,
			draft: null,
			messages: [
				{ role: 'assistant', content: completion.content, tool_calls: completion.toolCalls }
			]
		};
	}

	// A turn no decision model sorted: the model has every tool, and plans by itself
	const model = (state: TurnStep): Promise<TurnUpdate> =>
		answer(
			state,
			systemFor(state),
			deps.planning ? [...deps.tools.definitions, planDefinition] : deps.tools.definitions
		);

	const capabilityNames = new Set(deps.capabilities().map((capability) => capability.name));
	// The tools of a lane: the assistant's own always, and of what it can do in the applications,
	// what the lane needs. A model cannot call what it is not given.
	const toolsOf = (state: TurnStep): readonly LlmToolDefinition[] =>
		deps.tools.definitions.filter(
			(tool) =>
				state.lane === 'unsure' ||
				!capabilityNames.has(tool.function.name) ||
				state.named.includes(tool.function.name)
		);
	const inLane =
		(note?: string) =>
		(state: TurnStep): Promise<TurnUpdate> =>
			answer(state, systemFor(state, note), toolsOf(state));
	// The message asks for nothing in the applications: the model talks, with none of their tools
	const discuss = inLane();
	// It asks for something to be read: the model has those reads, and no write
	const consult = inLane();
	// It asks for something to be done: the model has what the plan names, and is held to it
	const act = inLane();
	// It may ask for something to be done: the model has every tool, and a write waits for a yes
	const unsure = inLane(
		'The user may be asking you to do something in their applications, or not. If you judge that they are, do it: they will be asked to confirm. If not, answer them.'
	);

	// Runs the calls of the model's last answer, in their order, up to the limit of the message
	async function tools(state: TurnStep): Promise<TurnUpdate> {
		const asked = state.messages.at(-1);
		const calls = asked?.tool_calls ?? [];
		const messages: LlmMessage[] = [];
		let { toolCalls, actions, plan } = state;
		// What the model wrote alongside its calls goes with each of them: a call that waits for its
		// owner shows it as the assistant's words
		const said = asked?.content ?? '';
		const context: ToolContext =
			said.trim().length === 0 ? input.context : { ...input.context, accompanyingText: said };
		for (const [index, call] of calls.entries()) {
			const args = parseArguments(call.function.arguments);
			// The plan is the turn's own, not a tool's: the first one of a turn counts for no call, a
			// later one does, so that a model cannot plan without end
			if (deps.planning && call.function.name === PLAN_TOOL && args !== null) {
				const read = readPlan(args, (name) => deps.tools.find(name) !== null);
				if (read.ok && plan === null) plan = read.steps;
				else if (toolCalls >= deps.maxToolCalls) {
					const late = calls.slice(index);
					messages.push(...skippedAnswers(late, limitReached(deps.maxToolCalls)));
					return { messages, toolCalls, actions, plan, notRun: late.length };
				} else {
					toolCalls += 1;
					if (read.ok) plan = read.steps;
				}
				deps.log.info(
					{ tool: PLAN_TOOL, status: read.ok ? 'ok' : 'invalid_arguments', durationMs: 0 },
					'tool called'
				);
				messages.push({
					role: 'tool',
					tool_call_id: call.id,
					name: PLAN_TOOL,
					content: JSON.stringify(read.ok ? { planned: read.steps.length } : { error: read.error })
				});
				continue;
			}
			if (toolCalls >= deps.maxToolCalls) {
				// This call and those after it never run
				const late = calls.slice(index);
				messages.push(...skippedAnswers(late, limitReached(deps.maxToolCalls)));
				return { messages, toolCalls, actions, plan, notRun: late.length };
			}
			toolCalls += 1;
			const tool = deps.tools.find(call.function.name);
			// A write is held to what the owner's message asks for, as the decision model read it:
			// one the message clearly does not ask for does not run, and one it may ask for waits for
			// the owner's yes whatever they allowed before
			const likely =
				state.asked !== null && catalog.isAction(call.function.name)
					? (state.asked[call.function.name] ?? 0)
					: 1;
			// Nor does a call to what the lane does not give the model, should it make one all the same
			const outOfLane =
				state.lane !== null &&
				state.lane !== 'unsure' &&
				capabilityNames.has(call.function.name) &&
				!state.named.includes(call.function.name);
			if (outOfLane || likely < REFUSE_THRESHOLD) {
				deps.log.info({ tool: call.function.name, status: 'not_asked' }, 'tool called');
				messages.push(...skippedAnswers([call], NOT_ASKED));
				continue;
			}
			const callContext: ToolContext =
				likely < WRITE_THRESHOLD ? { ...context, askOwner: true } : context;
			if (deps.planning) plan = withAction(plan, call.function.name, catalog);
			const first = catalog.isAction(call.function.name)
				? stepBefore(plan, call.function.name)
				: null;
			if (first !== null) {
				// The plan is kept in its order for what acts for the owner, whatever the model calls
				deps.log.info({ tool: call.function.name, status: 'step_order' }, 'tool called');
				messages.push(
					...skippedAnswers([call], {
						error: 'step_order',
						hint: `This call did not run: the step "${first.what}" (${first.tool}) of your plan comes before it and is not done. Do that step, then make this call again.`
					})
				);
				continue;
			}
			if (tool !== null && args !== null) actions += 1;
			const started = performance.now();
			const outcome =
				tool === null
					? { result: { error: `unknown tool ${call.function.name}` } }
					: args === null
						? { result: { error: 'arguments are not valid JSON' } }
						: await runTool(tool, args, callContext);
			const status: ToolCallStatus =
				tool === null
					? 'unknown_tool'
					: args === null
						? 'invalid_arguments'
						: toolCallStatus(outcome);
			deps.log.info(
				{
					tool: call.function.name,
					status,
					durationMs: Math.round(performance.now() - started)
				},
				'tool called'
			);
			deps.log.debug(
				{ tool: call.function.name, arguments: args, result: outcome.result },
				'tool called'
			);
			messages.push({
				role: 'tool',
				tool_call_id: call.id,
				name: call.function.name,
				content: JSON.stringify(outcome.result)
			});
			if (plan !== null) {
				plan = markDone(plan, call.function.name, outcome, catalog.detail(args));
			}
			if (outcome.final !== undefined) {
				// The calls the model made after this one never run
				messages.push(...skippedAnswers(calls.slice(index + 1), NOT_RUN));
				// The conversation keeps a request as the model may read it: without what an application
				// said of the call, which only its owner reads
				messages.push({
					role: 'assistant',
					content: outcome.request === undefined ? outcome.final : conversationText(outcome.request)
				});
				return {
					messages,
					toolCalls,
					actions,
					plan,
					answer: outcome.final,
					pendingCallId: outcome.pendingCallId,
					request: outcome.request
				};
			}
		}
		return { messages, toolCalls, actions, plan, iteration: state.iteration + 1 };
	}

	// The harness's own check of an answer the model gave without a call: it stands unless steps of
	// its plan are not done, when the model is sent back to them, once
	function check(state: TurnStep): TurnUpdate {
		const undone = undoneSteps(state.plan).length;
		if (undone === 0 || state.nudged) return { answer: state.draft };
		deps.log.info({ undone }, 'answer sent back to the plan');
		return { draft: null, nudged: true, iteration: state.iteration + 1 };
	}

	// The message ran all the calls it may: rather than fail, the turn ends on the model's own
	// account of what it did and what remains, which only the call that asks for it is told to give
	async function wrapUp(state: TurnStep): Promise<TurnUpdate> {
		deps.log.info(
			{ limit: deps.maxToolCalls, toolCalls: state.toolCalls, notRun: state.notRun },
			'tool call limit reached'
		);
		const { completion, tokens } = await askModel(
			deps,
			state.iteration + 1,
			[systemFor(state, wrapUpInstruction(deps.maxToolCalls)), ...past, ...state.messages],
			[]
		);
		// A model with no tools may still call one, through the API or in its text: those calls are
		// not for the owner, its words beside them are
		const written = completion.content ?? '';
		let answer = withoutCallMarkup(written);
		if (answer.length === 0) {
			const reason =
				written.trim().length > 0
					? 'markup'
					: completion.toolCalls.length > 0
						? 'tool_calls'
						: 'empty';
			deps.log.info({ actions: state.actions, reason }, 'tool call limit notice');
			answer = input.limitNotice(state.actions);
		}
		return { tokens, answer };
	}

	// The harness's check of the words of an answer, in a turn that could act for its owner and did
	// not: a model reads the answer sentence by sentence, with what came before it, and names those
	// that say the assistant did something in an application. Those sentences are taken out; the
	// owner then reads below the others that nothing was done. A check that fails changes nothing.
	async function verify(state: TurnStep): Promise<TurnUpdate> {
		const steps = state.plan ?? [];
		// A turn that did something for its owner may say so: only one that did nothing is checked
		const reported = steps.some((step) => step.done && deps.action(step.tool) !== null);
		const canAct = deps.tools.definitions.some((tool) => deps.action(tool.function.name) !== null);
		if (!deps.planning || !canAct || reported) return {};
		const words = state.answer ?? '';
		let spent = 0;
		if (deps.sortModel.length > 0) {
			// In a fraction of a second, a decision model tells the exchanges that have to do with
			// what the assistant can do for its owner: the others are sent as they are
			const actions = deps.tools.definitions
				.filter((tool) => deps.action(tool.function.name) !== null)
				.map((tool) => ({ name: tool.function.name, description: tool.function.description }));
			const asked = [...past, ...state.messages]
				.filter((message) => message.role === 'user')
				.at(-1);
			try {
				const started = performance.now();
				const sorted = await deps.llm.complete(
					sortRequest(actions, asked?.content ?? '', words),
					[],
					{ model: deps.sortModel }
				);
				spent += usedTokens(sorted);
				const probability = readSort(sorted.content);
				deps.log.info(
					{ probability, durationMs: Math.round(performance.now() - started) },
					'answer sorted'
				);
				if (!isConcerned(probability)) return { tokens: spent };
			} catch (err: unknown) {
				if (!(err instanceof LlmError)) throw err;
				deps.log.warn({ err }, 'answer not sorted');
			}
		}
		const sentences = sentencesOf(words, input.locale);
		// What the owner's events say, when the turn did not read them: a sentence that reports one is
		// then told from a sentence that claims an action
		const events = state.messages.some((message) => message.role === 'tool')
			? null
			: await input.ownerEvents();
		try {
			const { completion, tokens } = await askModel(
				deps,
				state.iteration + 1,
				checkPrompt([...past, ...state.messages, ...(events === null ? [] : [events])], sentences),
				[],
				{ model: deps.checkModel }
			);
			const claims = readClaims(completion.content, sentences.length);
			deps.log.info({ sentences: sentences.length, claims: claims.length }, 'answer checked');
			if (claims.length === 0) return { tokens: spent + tokens };
			// The owner reads no sentence that says something was done when nothing was
			return {
				tokens: spent + tokens,
				unfounded: true,
				answer: withoutSentences(words, sentences, claims)
			};
		} catch (err: unknown) {
			if (!(err instanceof LlmError)) throw err;
			deps.log.warn({ err }, 'answer not checked');
			return { tokens: spent };
		}
	}

	// The answer as the owner reads it and as the conversation keeps it: the model's words, and
	// below them the harness's own account, from the results of the calls and never from those
	// words: what was done for the owner, and the steps that stay undone
	function report(state: TurnStep): TurnUpdate {
		const undone = undoneSteps(state.plan);
		const done = (state.plan ?? []).filter((step) => step.done && deps.action(step.tool) !== null);
		if (undone.length > 0) deps.log.info({ undone: undone.length }, 'plan left undone');
		const words = state.answer ?? '';
		const { unfounded } = state;
		const answer = [
			words,
			...(done.length === 0
				? []
				: [
						input.doneNotice(
							done.map((step) =>
								step.detail === undefined ? step.what : `${step.what} (${step.detail})`
							)
						)
					]),
			...(undone.length === 0 ? [] : [input.stepsNotice(undone.map((step) => step.what))]),
			// The steps left undone already say that nothing was done
			...(unfounded && undone.length === 0 ? [input.nothingDoneNotice()] : [])
		]
			.filter((part) => part.length > 0)
			.join('\n\n');
		return { answer, messages: [{ role: 'assistant', content: answer }] };
	}

	const afterAnswer = (state: TurnStep): 'tools' | 'check' =>
		state.draft === null ? 'tools' : 'check';
	// The step where the model thinks, in this turn
	const THINKERS = ['model', 'discuss', 'consult', 'act', 'unsure'] as const;
	const thinker = (state: TurnStep): (typeof THINKERS)[number] => state.lane ?? 'model';

	const graph = new StateGraph(TurnState)
		.addNode('route', route)
		.addNode('model', model)
		.addNode('discuss', discuss)
		.addNode('consult', consult)
		.addNode('act', act)
		.addNode('unsure', unsure)
		.addNode('tools', tools)
		.addNode('check', check)
		.addNode('verify', verify)
		.addNode('wrapUp', wrapUp)
		.addNode('report', report)
		// A new message is sorted first, when the gateway serves a model for that
		.addConditionalEdges(
			START,
			() =>
				// An event's text is the harness's own: only what an owner wrote is sorted
				deps.planning &&
				deps.sortModel.length > 0 &&
				input.message !== null &&
				input.context.origin !== 'event'
					? 'route'
					: 'model',
			['route', 'model']
		)
		// The decision model sends the turn into its lane; one it did not sort goes to the model
		.addConditionalEdges('route', thinker, [...THINKERS])
		.addConditionalEdges('model', afterAnswer, ['tools', 'check'])
		.addConditionalEdges('discuss', afterAnswer, ['tools', 'check'])
		.addConditionalEdges('consult', afterAnswer, ['tools', 'check'])
		.addConditionalEdges('act', afterAnswer, ['tools', 'check'])
		.addConditionalEdges('unsure', afterAnswer, ['tools', 'check'])
		// What a call answered, and an answer sent back to its plan, return to the turn's own lane
		.addConditionalEdges(
			'tools',
			(state) => (state.answer !== null ? END : state.notRun > 0 ? 'wrapUp' : thinker(state)),
			[...THINKERS, 'wrapUp', END]
		)
		.addConditionalEdges('check', (state) => (state.answer === null ? thinker(state) : 'verify'), [
			...THINKERS,
			'verify'
		])
		.addEdge('verify', 'report')
		.addEdge('wrapUp', 'report')
		.addEdge('report', END)
		.compile();

	// A turn its owner's answer resumes goes on with the plan it had, and in the lane of that plan
	const resumed =
		deps.planning && input.message === null ? planFromHistory(input.history, catalog) : null;
	const end = await graph.invoke(
		{
			messages: input.message === null ? [] : [{ role: 'user', content: input.message }],
			toolCalls: 0,
			actions: input.actionsBefore,
			iteration: 0,
			notRun: 0,
			plan: resumed,
			lane: resumed !== null && deps.sortModel.length > 0 ? 'act' : null,
			named: (resumed ?? []).map((step) => step.tool),
			nudged: false,
			asked: null,
			unfounded: false,
			draft: null,
			answer: null,
			pendingCallId: undefined,
			request: undefined
		},
		// Every model answer that calls tools runs at least one of them or writes the turn's first
		// plan, so the limit of tool calls bounds the walk: two steps for each, and those of the
		// answer sent back to its plan, of the answer past the limit and of the report
		{ recursionLimit: 2 * deps.maxToolCalls + 14 }
	);
	if (end.answer === null) throw new TurnError('the turn ended without an answer');
	return {
		answer: end.answer,
		messages: [...input.history, ...end.messages],
		tokens: end.tokens,
		...(end.pendingCallId === undefined ? {} : { pendingCallId: end.pendingCallId }),
		...(end.request === undefined ? {} : { request: end.request })
	};
}
