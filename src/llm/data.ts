import { randomBytes } from 'node:crypto';

// Data as the model is handed it: one line of JSON, so that nothing a third party wrote can start
// a line of its own, between fences of a random nonce it cannot close
export function fenced(label: string, data: unknown): string {
	const nonce = randomBytes(6).toString('hex');
	return [`<<<${label} ${nonce}`, JSON.stringify(data), `${label} ${nonce}>>>`].join('\n');
}
