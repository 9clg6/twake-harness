import type { LlmMessage } from '../llm/client.js';
import { formatMemoryForPrompt, type MemoryView } from '../memory/repository.js';

export interface PromptInput {
	readonly persona: string;
	readonly memory: MemoryView;
	readonly history: readonly LlmMessage[];
	readonly nudgeInterval: number;
}

// Assistant turns since the model last wrote to its memory, in this session
export function countTurnsSinceMemory(history: readonly LlmMessage[]): number {
	let turns = 0;
	for (let i = history.length - 1; i >= 0; i -= 1) {
		const message = history[i];
		if (message === undefined) continue;
		if (message.role === 'tool' && message.name === 'memory') break;
		if (
			message.role === 'assistant' &&
			(message.tool_calls === undefined || message.tool_calls.length === 0)
		) {
			turns += 1;
		}
	}
	return turns;
}

export function buildSystemPrompt(input: PromptInput): string {
	const parts: string[] = [input.persona];
	const memory = formatMemoryForPrompt(input.memory);
	if (memory !== null) parts.push(memory);
	if (input.nudgeInterval > 0 && countTurnsSinceMemory(input.history) >= input.nudgeInterval - 1) {
		parts.push(
			'You have saved nothing to memory for a while. If this conversation holds something worth remembering about the user or your work, save it with the memory tool now.'
		);
	}
	return parts.join('\n\n');
}
