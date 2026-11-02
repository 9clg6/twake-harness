// What a model writes when it calls a tool in its text rather than through the API, as a model
// given no tools may still do: the tags its chat template wraps a call in, such as Qwen's
// <tool_call>, or the call itself in JSON. None of it is meant for the owner. Such a call ends
// the text: what the model wrote before it is its words, and a tag or a call it writes among its
// words, as when it explains them or shows one, is left as it is.

const TAG = '(?:tool_calls?|function_calls?)';
// What a tag that opens a block starts with, in lower case
const OPENINGS = ['<tool_call', '<function_call'];
// A block of tags, from the last tag that opens one to the end of the text
const BLOCK = new RegExp(`^<${TAG}\\b[^>]*>[\\s\\S]*?<\\/${TAG}\\s*>$`, 'i');
// A block the model left open at the end, which holds what a call starts with and no end of tag
const OPEN_BLOCK = new RegExp(`^<${TAG}\\b[^>]*>\\s*[[{](?:(?!<\\/${TAG}\\b)[\\s\\S])*$`, 'i');
// A fenced block, the whole text
const FENCED = /^```[^\n`]*\n?([\s\S]*?)```$/;
// Any block of tags, wherever it stands, which runs to the end of the text when left open
const ANY_BLOCK = new RegExp(`<${TAG}\\b[^>]*>[\\s\\S]*?(?:<\\/${TAG}\\s*>|$)`, 'gi');
// ponytail: a call in JSON that ends the text is looked for over its last lines only, a parse
// from each of them; one written over more lines is left as it is
const JSON_TAIL_LINES = 40;

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

// Where the last tag that opens a block starts before an end, in a text given in lower case, or
// -1 when none does: asked for ends that only go back, it looks for each tag again only once the
// one it found is past the end, so that a tag the text never holds is looked for once
function lastOpeningTag(lower: string): (end: number) => number {
	const found = OPENINGS.map(() => Number.POSITIVE_INFINITY);
	return (end) => {
		OPENINGS.forEach((opening, i) => {
			if ((found[i] ?? -1) >= end) found[i] = lower.lastIndexOf(opening, end - 1);
		});
		return Math.max(...found);
	};
}

// Where the call in JSON that ends the text at `end` starts, the longest over its last lines,
// or -1
function trailingJsonCallAt(text: string, end: number): number {
	// A call in JSON ends on a bracket: a text that ends otherwise holds none
	if (!/[\]}]/.test(text.charAt(end - 1))) return -1;
	let found = -1;
	let lineEnd = end;
	for (let line = 0; line < JSON_TAIL_LINES && lineEnd > 0; line += 1) {
		const start = text.lastIndexOf('\n', lineEnd - 1) + 1;
		if (isJsonCall(text.slice(start, end))) found = start;
		lineEnd = start - 1;
	}
	return found;
}

// Where the call that ends the text at `end` starts, or -1 when none does
function trailingCallAt(text: string, lastTag: (end: number) => number, end: number): number {
	const tag = lastTag(end);
	if (tag !== -1) {
		const suffix = text.slice(tag, end);
		if (BLOCK.test(suffix) || OPEN_BLOCK.test(suffix)) return tag;
	}
	// A fenced call is markup only when the text holds nothing else: after words, it is a block of
	// code the model shows
	if (text.startsWith('```') && text.endsWith('```', end)) {
		const fenced = FENCED.exec(text.slice(0, end));
		if (fenced !== null) return isJsonCall(fenced[1] ?? '') ? 0 : -1;
	}
	return trailingJsonCallAt(text, end);
}

// The end of the text at `end` without its trailing whitespace
function trimmedEnd(text: string, end: number): number {
	let at = end;
	while (at > 0 && /\s/.test(text.charAt(at - 1))) at -= 1;
	return at;
}

// The words of a model's text, without the tool calls that end it, one after the other. The text
// is read from its end, by indexes into it: a text of thousands of calls is read once.
export function withoutCallMarkup(text: string): string {
	const words = text.trimStart();
	const lower = words.toLowerCase();
	// A character whose lower case is longer, rare, would put the two out of step
	if (lower.length !== words.length) return withoutCallMarkup(words.normalize('NFC'));
	const lastTag = lastOpeningTag(lower);
	let end = trimmedEnd(words, words.length);
	for (;;) {
		const call = trailingCallAt(words, lastTag, end);
		if (call === -1) return words.slice(0, end);
		end = trimmedEnd(words, call);
	}
}

// The words of a text that may hold no call at all, as the brief of a model given no tool: every
// block of tags goes, wherever it stands, then what ends the text
export function withoutAnyCallMarkup(text: string): string {
	return withoutCallMarkup(text.replace(ANY_BLOCK, '').replace(/\n{3,}/g, '\n\n'));
}
