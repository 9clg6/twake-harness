import type { LlmMessage } from '../llm/client.js';
import { MAX_PLAN_STEPS } from './plan.js';

// One thing the assistant can do in an application of its owner: read there, or act there
export interface Capability {
	readonly name: string;
	readonly description: string;
	// Whether it acts for the owner, rather than read
	readonly acts: boolean;
}

// The least probability at which a message is read as asking for a capability. Higher for one
// that acts: a write the owner did not ask for is worse than a read they did not, and on the
// messages it was measured on, the decision model gave every write asked for 0.83 or more and no
// other more than 0.35.
export const READ_THRESHOLD = 0.5;
export const WRITE_THRESHOLD = 0.6;
// Below it, a message is read as not asking for a write at all: on the same messages, no write
// asked for was given less than 0.40
export const REFUSE_THRESHOLD = 0.2;
// The most characters of a message the decision model reads
const MESSAGE_CHARS = 1_500;
// The messages before the owner's last one it reads: a short answer, such as a name the assistant
// asked for, is of the request that came before it
const CONTEXT_MESSAGES = 4;

// What a decision model is asked of a message before the assistant's model reads it: for each
// thing the assistant can do in its owner's applications, whether the message asks for it. What
// a message asks for is thus told by a model made to classify, in a fraction of a second, and
// not left to the model that then does it. Such a model takes the state and typed questions in
// JSON as its last message, and answers each with a probability.
export function routeRequest(
	capabilities: readonly Capability[],
	before: readonly LlmMessage[],
	message: string
): LlmMessage[] {
	const context = before
		.filter((said) => said.role === 'user' || (said.role === 'assistant' && said.content !== null))
		.slice(-CONTEXT_MESSAGES)
		.map((said) => `${said.role}: ${(said.content ?? '').slice(0, MESSAGE_CHARS)}`);
	return [
		{
			role: 'user',
			content: JSON.stringify({
				state: `${context.length === 0 ? '' : `Earlier in the conversation:\n${context.join('\n')}\n\n`}User's last message to their assistant: ${message.slice(0, MESSAGE_CHARS)}`,
				questions: Object.fromEntries(
					capabilities.map((capability) => [
						capability.name,
						{
							type: 'noul',
							instructions: `Does the user's last message ask the assistant to do this now: "${capability.description}"?`
						}
					])
				)
			})
		}
	];
}

// The probability the decision model gave each capability, by its name, or null when the reply
// is not what was asked for
export function readProbabilities(reply: string | null): ReadonlyMap<string, number> | null {
	let answers: unknown;
	try {
		answers = (JSON.parse(reply ?? '') as { answers?: unknown }).answers;
	} catch {
		return null;
	}
	if (typeof answers !== 'object' || answers === null) return null;
	const given = new Map<string, number>();
	for (const [name, answer] of Object.entries(answers)) {
		const probability = (answer as { noul?: unknown } | null)?.noul;
		if (typeof probability === 'number') given.set(name, probability);
	}
	return given;
}

// The capabilities a message asks for, in the order they were given, or null when the reply is
// not what was asked for: the turn then goes on as it would without a decision model
export function readRoute(
	reply: string | null,
	capabilities: readonly Capability[]
): readonly Capability[] | null {
	const given = readProbabilities(reply);
	if (given === null) return null;
	return capabilities
		.filter(
			(capability) =>
				(given.get(capability.name) ?? 0) >= (capability.acts ? WRITE_THRESHOLD : READ_THRESHOLD)
		)
		.slice(0, MAX_PLAN_STEPS);
}
