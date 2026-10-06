import type { LlmMessage } from '../llm/client.js';

// The size of a message as the model reads it: its text and the arguments of its tool calls
export function computeMessageSize(message: LlmMessage): number {
	let total = message.content?.length ?? 0;
	for (const call of message.tool_calls ?? []) total += call.function.arguments.length;
	return total;
}

// The part of a conversation a turn shows the model: its most recent exchanges within a budget of
// characters, and always the last exchange. The window only ever begins on a user message, or at
// the very start, so that a call the model made and the results answering it are kept or dropped
// together. The session itself keeps every message.
export function computeVisibleHistory(
	history: readonly LlmMessage[],
	maxChars: number
): readonly LlmMessage[] {
	let used = 0;
	let start = history.length;
	// The size of the exchange being read backwards, until the user message that begins it
	let exchange = 0;
	for (let i = history.length - 1; i >= 0; i -= 1) {
		const message = history[i];
		if (message === undefined) break;
		exchange += computeMessageSize(message);
		if (message.role !== 'user' && i > 0) continue;
		// The last exchange stays whatever its size: without it the model would answer out of context
		if (start < history.length && used + exchange > maxChars) break;
		used += exchange;
		exchange = 0;
		start = i;
	}
	return history.slice(start);
}
