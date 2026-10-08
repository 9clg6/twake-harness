import { problemCode } from '../contracts/problem.js';

// Why the platform's broker refused to act for an owner: they never gave their assistant the
// permission to act for them, or the one they gave expired
const DELEGATION_CODES = ['delegation_missing', 'delegation_expired'] as const;
export type DelegationCode = (typeof DELEGATION_CODES)[number];

function isDelegationCode(value: unknown): value is DelegationCode {
	return typeof value === 'string' && (DELEGATION_CODES as readonly string[]).includes(value);
}

// The code by which an RFC 9457 problem of the broker says why it holds no permission it can use,
// if it says so
export function readProblemCode(body: unknown): DelegationCode | null {
	const code = problemCode(body);
	return isDelegationCode(code) ? code : null;
}

// The broker's refusal of a contract call, as the gateway relays it: a 401 whose RFC 9457 problem
// says why in its code. Nothing else of it is read: a contract could write the same answer, so
// the link it carries is never shown to the owner.
export function readDelegationCode(status: number, body: unknown): DelegationCode | null {
	return status === 401 ? readProblemCode(body) : null;
}
