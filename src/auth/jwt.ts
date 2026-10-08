import { createRemoteJWKSet, jwtVerify } from 'jose';

import { isValidPrincipalId, type Principal } from '../principals/principal.js';

export type AuthResult =
	| { readonly ok: true; readonly principal: Principal }
	| { readonly ok: false; readonly reason: 'missing' | 'invalid' };

export type Authenticator = (authorization: string | undefined) => Promise<AuthResult>;

export interface JwtOptions {
	readonly jwksUrl: URL;
	readonly issuer: string;
	// Any one of them is accepted
	readonly audience: string | readonly string[];
}

const BEARER_PREFIX = /^Bearer\s+(.+)$/i;

export function makeJwtAuthenticator(options: JwtOptions): Authenticator {
	const jwks = createRemoteJWKSet(options.jwksUrl);
	return async (authorization) => {
		const match = authorization === undefined ? null : BEARER_PREFIX.exec(authorization);
		if (match === null || match[1] === undefined) {
			return { ok: false, reason: 'missing' };
		}
		try {
			const { payload } = await jwtVerify(match[1], jwks, {
				issuer: options.issuer,
				audience: typeof options.audience === 'string' ? options.audience : [...options.audience],
				algorithms: ['RS256'],
				requiredClaims: ['sub', 'iat', 'exp']
			});
			if (!isValidPrincipalId(payload.sub)) {
				return { ok: false, reason: 'invalid' };
			}
			return { ok: true, principal: { id: payload.sub } };
		} catch {
			return { ok: false, reason: 'invalid' };
		}
	};
}
