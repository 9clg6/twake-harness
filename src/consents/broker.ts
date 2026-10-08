import { z } from 'zod';

import type { Config } from '../config.js';
import { joinPath, parseBody } from '../contracts/tools.js';
import { readProblemCode } from './delegation.js';

// An owner's permission for their assistant to act for them, as the platform's token broker holds
// it: when they gave it and when it expires
export interface Delegation {
	readonly consentedAt: Date;
	readonly expiresAt: Date;
}

// The broker's answer about a permission it holds, expired or not: its dates in RFC 3339. Its
// consent link is never read: the harness shows its owner the deployment's own.
const heldSchema = z.object({
	consented_at: z.iso.datetime({ offset: true }),
	expires_at: z.iso.datetime({ offset: true })
});

// The gateway publishes no route at the path the harness asks the broker on: the path, for its
// operator to publish it there
export class DelegationRouteMissingError extends Error {
	override readonly name = 'DelegationRouteMissingError';
	constructor(readonly path: string) {
		super(`the gateway publishes no delegation route at ${path}`);
	}
}

// Whether an answer is the broker's own word that it holds no permission of the owner: an RFC
// 9457 problem whose code says so. A 404 of the gateway, which has no such route, is none.
function isMissing(status: number, body: unknown): boolean {
	return status === 404 && readProblemCode(body) === 'delegation_missing';
}

// The broker's route about an owner's permission, asked through the gateway the way a contract
// call is: under the same path, with the harness's key and the owner named the same way, the
// gateway naming them to the broker in turn
function delegationRoute(config: Config, owner: string): { url: URL; init: RequestInit } {
	return {
		url: joinPath(config.apisix.baseUrl, config.contracts.basePath, 'delegation'),
		init: {
			headers: { apikey: config.apisix.consumerKey, 'x-twake-on-behalf-of': owner },
			signal: AbortSignal.timeout(config.contracts.timeoutMs)
		}
	};
}

// What the broker holds of an owner's permission. Resolves to the permission, expired or not, or
// to null when the broker holds none, never gave or revoked. Any other 404 is the gateway's,
// without the route, and throws a DelegationRouteMissingError; any other answer, a broker down, or
// none in time, throws.
export async function fetchDelegation(config: Config, owner: string): Promise<Delegation | null> {
	const { url, init } = delegationRoute(config, owner);
	const response = await fetch(url, init);
	const body = parseBody(await response.text());
	if (isMissing(response.status, body)) return null;
	if (response.status === 404) throw new DelegationRouteMissingError(url.pathname);
	if (response.status !== 200) {
		throw new Error(`the delegation route answered ${response.status}`);
	}
	const held = heldSchema.safeParse(body);
	if (!held.success) throw new Error('the delegation route answered no permission it could read');
	return {
		consentedAt: new Date(held.data.consented_at),
		expiresAt: new Date(held.data.expires_at)
	};
}

// Revokes an owner's permission at the broker, which erases it, if it holds one, then leaves the
// owner's Drive instance, as one answer of no content says. A 404 is the gateway's, without the
// route, and throws a DelegationRouteMissingError. Any other answer throws: a 502 when the Drive
// instance did not answer, the permission erased all the same and the broker still on the instance,
// as does a broker down, or none in time, which may have erased it or not.
export async function revokeDelegation(config: Config, owner: string): Promise<void> {
	const { url, init } = delegationRoute(config, owner);
	const response = await fetch(url, { ...init, method: 'DELETE' });
	await response.text();
	if (response.ok) return;
	if (response.status === 404) throw new DelegationRouteMissingError(url.pathname);
	throw new Error(`the delegation route answered ${response.status} to the revocation`);
}
