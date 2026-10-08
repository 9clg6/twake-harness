import { randomBytes } from 'node:crypto';

// Data as the model is handed it: one line of JSON, so that nothing a third party wrote can start
// a line of its own, between fences of a random nonce it cannot close
export function fenced(label: string, data: unknown): string {
	const nonce = randomBytes(6).toString('hex');
	return [`<<<${label} ${nonce}`, JSON.stringify(data), `${label} ${nonce}>>>`].join('\n');
}

// Text people wrote, cut to its first characters rather than refused, as the contracts cap theirs:
// it is shown as data anyway
export function cut(text: string, max: number): string {
	const characters = Array.from(text);
	return characters.length <= max ? text : characters.slice(0, max).join('');
}
