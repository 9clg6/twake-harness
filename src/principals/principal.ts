export interface Principal {
	readonly id: string;
}

const MAX_PRINCIPAL_ID_LENGTH = 128;

export function isValidPrincipalId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_PRINCIPAL_ID_LENGTH;
}
