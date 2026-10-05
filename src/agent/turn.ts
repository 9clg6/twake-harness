import type { FastifyBaseLogger } from 'fastify';

import type { LlmClient, LlmMessage } from '../llm/client.js';
import { runTool, type ToolContext, type ToolRegistry } from './tools.js';

export interface TurnInput {
	readonly systemPrompt: string;
	readonly history: readonly LlmMessage[];
	readonly message: string;
	readonly context: ToolContext;
}

export interface TurnOutput {
	readonly answer: string;
	readonly messages: readonly LlmMessage[];
}

export interface TurnDeps {
	readonly llm: LlmClient;
	readonly tools: ToolRegistry;
	readonly log: FastifyBaseLogger;
	readonly maxToolCalls: number;
}

export class TurnError extends Error {
	override readonly name = 'TurnError';
}

function parseArguments(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

// One turn: the model answers, possibly through tool calls, within a bounded number of calls.
// Every exchange with the model and every tool call is logged in clear.
export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<TurnOutput> {
	const messages: LlmMessage[] = [...input.history, { role: 'user', content: input.message }];
	const system: LlmMessage = { role: 'system', content: input.systemPrompt };
	let toolCalls = 0;
	for (let iteration = 0; iteration <= deps.maxToolCalls; iteration += 1) {
		const prompt = [system, ...messages];
		deps.log.info({ iteration, messages: prompt }, 'model asked');
		const completion = await deps.llm.complete(prompt, deps.tools.definitions);
		deps.log.info(
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
		if (completion.toolCalls.length === 0) {
			const answer = completion.content ?? '';
			if (answer.length === 0) throw new TurnError('the model answered nothing');
			messages.push({ role: 'assistant', content: answer });
			return { answer, messages };
		}
		messages.push({
			role: 'assistant',
			content: completion.content,
			tool_calls: completion.toolCalls
		});
		for (const call of completion.toolCalls) {
			toolCalls += 1;
			if (toolCalls > deps.maxToolCalls) {
				throw new TurnError(`the model exceeded ${deps.maxToolCalls} tool calls`);
			}
			const tool = deps.tools.find(call.function.name);
			const args = parseArguments(call.function.arguments);
			const outcome =
				tool === null
					? { result: { error: `unknown tool ${call.function.name}` } }
					: args === null
						? { result: { error: 'arguments are not valid JSON' } }
						: await runTool(tool, args, input.context);
			deps.log.info(
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
				messages.push({ role: 'assistant', content: outcome.final });
				return { answer: outcome.final, messages };
			}
		}
	}
	throw new TurnError('the turn did not finish within the allowed model calls');
}
