// The code by which an RFC 9457 problem says why a call was refused, as the platform's broker and
// contracts write it: null for a body that carries none. Nothing else of the problem is read, and
// which status the refusal comes with is for the reader of each code to check.
export function problemCode(body: unknown): unknown {
	return typeof body === 'object' && body !== null && 'code' in body ? body.code : null;
}
