import { problemCode } from '../contracts/problem.js';

// Why a call waits until its owner gives the platform what it lacks to act for them, with the status
// each refusal comes with and the broker's step where they give it: the permission for their
// assistant to act for them, which the broker holds, never given or expired, given on its whole
// consent; or, for Twake Space, their API token, which the broker holds along with that permission
// and which they give on its Twake Space step: none given yet, one Space no longer accepts, or one
// short of the scope the call needs, as the contract tells
const DELEGATION_REFUSALS = {
	delegation_missing: { status: 401, step: null },
	delegation_expired: { status: 401, step: null },
	space_token_missing: { status: 401, step: 'space' },
	space_token_rejected: { status: 401, step: 'space' },
	space_scope_missing: { status: 403, step: 'space' }
} as const;
export type DelegationCode = keyof typeof DELEGATION_REFUSALS;

function isDelegationCode(value: unknown): value is DelegationCode {
	return typeof value === 'string' && Object.hasOwn(DELEGATION_REFUSALS, value);
}

// The scopes of a Twake Space API token that the harness names to an owner in Space's own words
const SPACE_SCOPES = ['space:read', 'space:write', 'members:write', 'feed:read'] as const;
export type SpaceScope = (typeof SPACE_SCOPES)[number];

function isSpaceScope(value: unknown): value is SpaceScope {
	return typeof value === 'string' && (SPACE_SCOPES as readonly string[]).includes(value);
}

// What a refusal says its owner must give first: why, and for a Space token short of a scope, that
// scope when it is one the harness names, null for any other
export interface DelegationRefusal {
	readonly code: DelegationCode;
	readonly scope: SpaceScope | null;
}

// The code by which an RFC 9457 problem, the broker's or a contract's, says why the platform cannot
// act for the owner until they give it what it lacks, if it says so
export function readProblemCode(body: unknown): DelegationCode | null {
	const code = problemCode(body);
	return isDelegationCode(code) ? code : null;
}

// The refusal of a contract call, as the gateway relays it: the broker's or the contract's, an RFC
// 9457 problem that says why in its code, with the status that code comes with. Nothing else of it
// is read but the scope a Space token lacks, which only picks among the harness's own words: a
// contract could write the same answer, so neither the link it carries nor any of its text is ever
// shown to the owner.
export function readDelegationRefusal(status: number, body: unknown): DelegationRefusal | null {
	const code = readProblemCode(body);
	if (code === null || DELEGATION_REFUSALS[code].status !== status) return null;
	const scope =
		code === 'space_scope_missing' && typeof body === 'object' && body !== null && 'scope' in body
			? body.scope
			: null;
	return { code, scope: isSpaceScope(scope) ? scope : null };
}

// The broker's step where the owner gives what a refusal lacks: its Twake Space step for their
// Space API token, or, null, its whole consent
export function consentStepOf(code: DelegationCode): 'space' | null {
	return DELEGATION_REFUSALS[code].step;
}
