import { z } from 'zod';

import type { Config } from '../config.js';
import { joinPath } from '../contracts/tools.js';

// An owner's permission for their assistant to act for them, as the platform's token broker holds
// it: when they gave it and when it expires, and the broker's consent link, where they renew it
export interface Delegation {
	readonly consentedAt: Date;
	readonly expiresAt: Date;
	readonly consentUrl: string;
}

// The broker's answer about a permission it holds, expired or not: its dates in RFC 3339, and a
// link the harness shows its owner, so an https URL only
const heldSchema = z.object({
	consented_at: z.iso.datetime({ offset: true }),
	expires_at: z.iso.datetime({ offset: true }),
	consent_url: z.url({ protocol: /^https$/ })
});

function parseBody(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

// Whether an answer is the broker's own word that it holds no permission of the owner: an RFC
// 9457 problem whose code says so. A 404 of the gateway, which has no such route, is none.
function isMissing(status: number, body: unknown): boolean {
	return (
		status === 404 &&
		typeof body === 'object' &&
		body !== null &&
		'code' in body &&
		body.code === 'delegation_missing'
	);
}

// What the broker holds of an owner's permission, asked through the gateway the way a contract
// call is: under the same path, with the harness's key and the owner named the same way, the
// gateway naming them to the broker in turn. Resolves to the permission, expired or not, or to
// null when the broker holds none, never gave or revoked. Any other answer, a gateway without
// the route or a broker down, or none in time, throws.
export async function fetchDelegation(config: Config, owner: string): Promise<Delegation | null> {
	const response = await fetch(
		joinPath(config.apisix.baseUrl, config.contracts.basePath, 'delegation'),
		{
			headers: { apikey: config.apisix.consumerKey, 'x-twake-on-behalf-of': owner },
			signal: AbortSignal.timeout(config.contracts.timeoutMs)
		}
	);
	const body = parseBody(await response.text());
	if (isMissing(response.status, body)) return null;
	if (response.status !== 200) {
		throw new Error(`the delegation route answered ${response.status}`);
	}
	const held = heldSchema.safeParse(body);
	if (!held.success) throw new Error('the delegation route answered no permission it could read');
	return {
		consentedAt: new Date(held.data.consented_at),
		expiresAt: new Date(held.data.expires_at),
		consentUrl: held.data.consent_url
	};
}
