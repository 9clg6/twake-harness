export interface Principal {
	readonly id: string;
}

const MAX_PRINCIPAL_ID_LENGTH = 128;

// The organization's own principal, whose memory and skills library are the organization's; it is
// never the subject of a token, so no user can act as it
export const ORGANIZATION_PRINCIPAL = 'org';

export function isValidPrincipalId(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_PRINCIPAL_ID_LENGTH &&
		value !== ORGANIZATION_PRINCIPAL
	);
}
