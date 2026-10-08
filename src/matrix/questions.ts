// The key by which the content of a message of the harness tells its owner's client that it asks
// them a question to answer yes or no, and which one: the client may offer both answers under it
// until the question expires, and send the one chosen as the owner's own words, which answer it as
// typed ones do. The text asks the same without it, for any other client.
const QUESTION_KEY = 'app.twake.assistant.question';

// A question its owner answers yes or no in their next message: what identifies it, and when it
// stops taking answers, in milliseconds since the epoch
export interface YesNoQuestion {
	readonly id: string;
	readonly expiresTs: number;
}

export function isYesNoQuestion(value: unknown): value is YesNoQuestion {
	if (typeof value !== 'object' || value === null) return false;
	const question = value as Record<string, unknown>;
	return typeof question['id'] === 'string' && Number.isFinite(question['expiresTs']);
}

// The content of a message that asks a yes or no question: its text as it is, and the question it
// asks. Every yes or no question of the harness goes out this way, whatever it is about, so that
// the owner's client knows each one without reading its text.
export function markQuestion(content: object, question: YesNoQuestion): Record<string, unknown> {
	return { ...content, [QUESTION_KEY]: { id: question.id, expires_ts: question.expiresTs } };
}
