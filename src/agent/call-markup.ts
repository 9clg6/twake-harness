// What a model writes when it calls a tool in its text rather than through the API, as a model
// given no tools may still do: the tags its chat template wraps a call in, such as Qwen's
// <tool_call>, or the call itself in JSON. None of it is meant for the owner.

// A block of those tags, which runs to the end of the text when the model left it open
const CALL_TAGS = /<(tool_calls?|function_calls?)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const STRAY_CLOSING_TAGS = /<\/(?:tool_calls?|function_calls?)\s*>/gi;
// A fenced block, its body apart
const FENCED = /```[^\n`]*\n?([\s\S]*?)```/g;

// A call to a function, or a list of them, as chat templates write one (its name with its
// arguments or parameters) or as the OpenAI API carries it (under function, or tool_calls)
function isFunctionCall(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0 && value.every(isFunctionCall);
	if (typeof value !== 'object' || value === null) return false;
	const fields = value as Record<string, unknown>;
	if (typeof fields['name'] === 'string' && ('arguments' in fields || 'parameters' in fields)) {
		return true;
	}
	return isFunctionCall(fields['function']) || isFunctionCall(fields['tool_calls']);
}

function isJsonCall(text: string): boolean {
	const trimmed = text.trim();
	if (!/^[[{][\s\S]*[\]}]$/.test(trimmed)) return false;
	try {
		return isFunctionCall(JSON.parse(trimmed));
	} catch {
		return false;
	}
}

// The words of a model's text, without the tool calls it wrote in it: their tags, a fenced block
// that holds only calls, and calls in JSON, whether the whole text or a line of its own
export function withoutCallMarkup(text: string): string {
	const untagged = text.replace(CALL_TAGS, '').replace(STRAY_CLOSING_TAGS, '');
	const unfenced = untagged.replace(FENCED, (block: string, body: string) =>
		isJsonCall(body) ? '' : block
	);
	if (isJsonCall(unfenced)) return '';
	return unfenced
		.split('\n')
		.filter((line) => !isJsonCall(line))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
