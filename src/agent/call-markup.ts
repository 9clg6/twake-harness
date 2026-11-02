// What a model writes when it calls a tool in its text rather than through the API, as a model
// given no tools may still do: the tags its chat template wraps a call in, such as Qwen's
// <tool_call>, or the call itself in JSON. None of it is meant for the owner. Such a call ends
// the text: what the model wrote before it is its words, and a tag or a call it writes among its
// words, as when it explains them or shows one, is left as it is.

const TAG = '(?:tool_calls?|function_calls?)';
// A block of tags that ends the text
const TRAILING_BLOCK = new RegExp(`<${TAG}\\b[^>]*>[\\s\\S]*?<\\/${TAG}\\s*>$`, 'i');
// A block the model left open at the end, which holds what a call starts with and no end of tag
const TRAILING_OPEN_BLOCK = new RegExp(
	`<${TAG}\\b[^>]*>\\s*[[{](?:(?!<\\/${TAG}\\s*>)[\\s\\S])*$`,
	'i'
);
// A fenced block
const FENCED = /^```[^\n`]*\n?([\s\S]*?)```$/;

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

// Where the call in JSON that ends the text starts, over one line or more, or -1 when none does
function trailingJsonCallAt(text: string): number {
	// ponytail: a parse per line from the top, on texts of a few lines
	let at = 0;
	for (;;) {
		if (isJsonCall(text.slice(at))) return at;
		const next = text.indexOf('\n', at);
		if (next === -1) return -1;
		at = next + 1;
	}
}

// The text without the call that ends it, or null when none does
function withoutTrailingCall(text: string): string | null {
	const block = TRAILING_BLOCK.exec(text) ?? TRAILING_OPEN_BLOCK.exec(text);
	if (block !== null) return text.slice(0, block.index);
	// A fenced call is markup only when the text holds nothing else: after words, it is a block of
	// code the model shows
	const fenced = FENCED.exec(text);
	if (fenced !== null) return isJsonCall(fenced[1] ?? '') ? '' : null;
	const call = trailingJsonCallAt(text);
	return call === -1 ? null : text.slice(0, call);
}

// The words of a model's text, without the tool calls that end it
export function withoutCallMarkup(text: string): string {
	let words = text.trim();
	for (;;) {
		const shorter = withoutTrailingCall(words);
		if (shorter === null) return words;
		words = shorter.trim();
	}
}
