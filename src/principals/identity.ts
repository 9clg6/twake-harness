import type { Config } from '../config.js';

// What Synapse accepts as a localpart, and what the harness puts in front of an assistant's identifier
const LOCALPART = /^[a-z0-9._=\-/+]+$/;

// One person has one principal everywhere in the harness: the subject of their platform token,
// their email. A user of our homeserver is that same person, so their Matrix identifier maps to
// the same principal, through the mail domain the platform gives its users.
export function principalOfMatrixUser(config: Config, userId: string): string | null {
	const match = /^@([^:]+):(.+)$/.exec(userId);
	if (match === null) return null;
	const [, localpart, server] = match;
	if (
		localpart === undefined ||
		server !== config.matrix.serverName ||
		!LOCALPART.test(localpart)
	) {
		return null;
	}
	return `${localpart}@${config.matrix.mailDomain}`;
}

// The localpart of a principal on our homeserver, or null when the principal belongs to another
// mail domain and so has no account there
export function matrixLocalpartOfPrincipal(config: Config, principal: string): string | null {
	const suffix = `@${config.matrix.mailDomain}`;
	if (!principal.endsWith(suffix)) return null;
	const localpart = principal.slice(0, -suffix.length);
	return LOCALPART.test(localpart) ? localpart : null;
}

export function matrixUserIdOfPrincipal(config: Config, principal: string): string | null {
	const localpart = matrixLocalpartOfPrincipal(config, principal);
	return localpart === null ? null : `@${localpart}:${config.matrix.serverName}`;
}
