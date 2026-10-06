import type { FastifyBaseLogger } from 'fastify';

import type { LlmClient, LlmCompletion, LlmMessage } from '../llm/client.js';
import { conversationText, type OwnerRequest } from '../consents/request.js';
import { computeMessageSize, computeVisibleHistory } from './history.js';
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

function parseArguments(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

// One turn: the model answers, possibly through tool calls, within a bounded number of calls.
// Every model call and every tool call is logged at info with its metadata only. The conversation
// itself (prompt, answer, reasoning, tool arguments and results) goes to debug: messages reach the
// harness end-to-end encrypted and are decrypted only here, so their text must stay out of the
// production logs.
export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<TurnOutput> {
	// What this turn adds to the conversation, which the model always reads whole
	const messages: LlmMessage[] =
		input.message === null ? [] : [{ role: 'user', content: input.message }];
	const past = computeVisibleHistory(input.history, deps.historyMaxChars);
	if (past.length < input.history.length) {
		deps.log.info(
			{ historyMessages: input.history.length, shownMessages: past.length },
			'history windowed'
		);
	}
	const system: LlmMessage = { role: 'system', content: input.systemPrompt };
	let toolCalls = 0;
	let tokens = 0;
	for (let iteration = 0; iteration <= deps.maxToolCalls; iteration += 1) {
		const prompt = [system, ...past, ...messages];
		deps.log.info(
			{ iteration, messageCount: prompt.length, characters: countCharacters(prompt) },
			'model asked'
		);
		deps.log.debug({ iteration, messages: prompt }, 'model asked');
		let completion = await deps.llm.complete(prompt, deps.tools.definitions);
		tokens += usedTokens(completion);
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
				completion = await deps.llm.complete(prompt, deps.tools.definitions, {
					maxTokens: retryBudget
				});
				tokens += usedTokens(completion);
				logAnswer(deps.log, iteration, completion);
			}
		}
		if (completion.toolCalls.length === 0) {
			const answer = completion.content ?? '';
			if (answer.length === 0) throw new TurnError('the model answered nothing');
			messages.push({ role: 'assistant', content: answer });
			return { answer, messages: [...input.history, ...messages], tokens };
		}
		messages.push({
			role: 'assistant',
			content: completion.content,
			tool_calls: completion.toolCalls
		});
		// What the model wrote alongside its calls goes with each of them: a call that waits for its
		// owner shows it as the assistant's words
		const said = completion.content ?? '';
		const context: ToolContext =
			said.trim().length === 0 ? input.context : { ...input.context, accompanyingText: said };
		for (const [index, call] of completion.toolCalls.entries()) {
			toolCalls += 1;
			if (toolCalls > deps.maxToolCalls) {
				throw new TurnError(`the model exceeded ${deps.maxToolCalls} tool calls`);
			}
			const tool = deps.tools.find(call.function.name);
			const args = parseArguments(call.function.arguments);
			const started = performance.now();
			const outcome =
				tool === null
					? { result: { error: `unknown tool ${call.function.name}` } }
					: args === null
						? { result: { error: 'arguments are not valid JSON' } }
						: await runTool(tool, args, context);
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
			if (outcome.final !== undefined) {
				// The calls the model made after this one never run, yet each gets its answer: strict
				// model APIs refuse a history with a call left unanswered
				for (const skipped of completion.toolCalls.slice(index + 1)) {
					messages.push({
						role: 'tool',
						tool_call_id: skipped.id,
						name: skipped.function.name,
						content: JSON.stringify(NOT_RUN)
					});
				}
				// The conversation keeps a request as the model may read it: without what an application
				// said of the call, which only its owner reads
				messages.push({
					role: 'assistant',
					content: outcome.request === undefined ? outcome.final : conversationText(outcome.request)
				});
				return {
					answer: outcome.final,
					messages: [...input.history, ...messages],
					tokens,
					...(outcome.pendingCallId === undefined ? {} : { pendingCallId: outcome.pendingCallId }),
					...(outcome.request === undefined ? {} : { request: outcome.request })
				};
			}
		}
	}
	throw new TurnError('the turn did not finish within the allowed model calls');
}
