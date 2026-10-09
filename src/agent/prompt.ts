import type { LlmMessage } from '../llm/client.js';
import { formatMemoryForPrompt, type MemoryView } from '../memory/repository.js';
import type { SkillSummary } from '../skills/repository.js';

// What a turn an activity woke is told of itself: it may say nothing, and says little otherwise
const WOKEN_TURN_RULE =
	"This turn was started by an activity in your user's applications, not by a message from them. If nothing in it is useful to them, answer with nothing at all: they then see nothing. Otherwise suggest it in a few words, and prepare at most one action, which waits for their yes.";

export interface PromptInput {
	readonly persona: string;
	// The present, as the turn started: what "today" and "this afternoon" mean
	readonly moment?: string;
	// Whether an activity woke the turn, rather than a message of its owner
	readonly woken?: boolean;
	readonly memory: MemoryView;
	readonly skills?: readonly SkillSummary[];
	readonly history: readonly LlmMessage[];
	readonly nudgeInterval: number;
}

// Skills are discovered by their description; the model reads one when it applies
export function formatSkillsForPrompt(skills: readonly SkillSummary[]): string | null {
	if (skills.length === 0) return null;
	const lines = skills.map(
		(s) => `- ${s.id} (${s.scope === 'org' ? 'organization' : 'yours'}): ${s.description}`
	);
	return `## Skills\nRead a skill with scoped_skills_read when its description matches the task, then follow it.\n${lines.join('\n')}`;
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
	if (input.moment !== undefined) parts.push(input.moment);
	if (input.woken === true) parts.push(WOKEN_TURN_RULE);
	const memory = formatMemoryForPrompt(input.memory);
	if (memory !== null) parts.push(memory);
	const skills = formatSkillsForPrompt(input.skills ?? []);
	if (skills !== null) parts.push(skills);
	if (input.nudgeInterval > 0 && countTurnsSinceMemory(input.history) >= input.nudgeInterval - 1) {
		parts.push(
			'You have saved nothing to memory for a while. If this conversation holds something worth remembering about the user or your work, save it with the memory tool now.'
		);
	}
	return parts.join('\n\n');
}
