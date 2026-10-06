import type { DelegationCode } from './consent.js';

// The broker's refusal of a contract call, as the gateway relays it: the owner never gave their
// assistant the permission to act for them on the platform, or it expired, and the link where
// they give it
export interface DelegationRefusal {
	readonly code: DelegationCode;
	// The link as the broker gave it, or null when it is not one to show the owner
	readonly link: string | null;
}

// The broker answers with an RFC 9457 problem: a 401 whose code says why, its link in consent_url
export function readDelegationRefusal(status: number, body: unknown): DelegationRefusal | null {
	if (status !== 401 || typeof body !== 'object' || body === null) return null;
	const fields = body as Record<string, unknown>;
	const code = fields['code'];
	if (code !== 'delegation_missing' && code !== 'delegation_expired') return null;
	return { code, link: consentLinkOf(fields['consent_url']) };
}

// The link comes from an answer a third party could have written: it is shown only when it is an
// https URL, carrying no credentials, written exactly as a browser writes it, so that what the
// owner reads is where it leads
function consentLinkOf(value: unknown): string | null {
	if (typeof value !== 'string' || !URL.canParse(value)) return null;
	const url = new URL(value);
	const plain =
		url.protocol === 'https:' && url.username === '' && url.password === '' && url.href === value;
	return plain ? value : null;
}
