// A JSON object, as the homeserver's answers and events hold them: neither null nor an array
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
