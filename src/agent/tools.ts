import { z } from 'zod';

import type { LlmToolDefinition } from '../llm/client.js';

export interface ToolOutcome {
	// What the model reads back
	readonly result: unknown;
	// When set, the turn ends with this text as the answer to the user
	readonly final?: string;
}

export interface ToolContext {
	readonly principalId: string;
}

export interface Tool {
	readonly definition: LlmToolDefinition;
	run(args: unknown, context: ToolContext): Promise<ToolOutcome>;
}

export interface ToolRegistry {
	readonly definitions: readonly LlmToolDefinition[];
	find(name: string): Tool | null;
}

export function makeToolRegistry(tools: readonly Tool[]): ToolRegistry {
	const byName = new Map(tools.map((tool) => [tool.definition.function.name, tool]));
	return {
		definitions: tools.map((tool) => tool.definition),
		find: (name) => byName.get(name) ?? null
	};
}

const clarifyArgs = z.object({ question: z.string().min(1) });

// Asking the user a question ends the turn: the question is the answer.
export const clarifyTool: Tool = {
	definition: {
		type: 'function',
		function: {
			name: 'clarify',
			description:
				'Ask the user one short question when the request is ambiguous and you cannot proceed without the answer.',
			parameters: {
				type: 'object',
				properties: { question: { type: 'string', description: 'The question to ask' } },
				required: ['question'],
				additionalProperties: false
			}
		}
	},
	run: async (args) => {
		const parsed = clarifyArgs.safeParse(args);
		if (!parsed.success) return { result: { error: 'question is required' } };
		return { result: { asked: true }, final: parsed.data.question };
	}
};
