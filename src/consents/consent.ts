// A contract call reads its application for a GET contract and writes it otherwise; an owner
// allows each level of each application on its own
export type ConsentLevel = 'read' | 'write';

export function isConsentLevel(value: unknown): value is ConsentLevel {
	return value === 'read' || value === 'write';
}

// Why a call waits for its owner: an application they never allowed at that level; a write that a
// turn an event started prepared, or a high-risk write, which they confirm call by call whatever
// they allowed; the platform's own permission for their assistant to act for them, which its
// broker lacks; or a recurring invitation, which its contract answers only for the whole series,
// once they said so. One request asks about every reason that applies.
export type WaitReason = 'consent' | 'event_turn' | 'high_risk' | 'delegation' | 'series';

export type ConsentSource = 'chat' | 'api' | 'migration';

// The reactions by which an owner allows, or refuses, a call the harness asked them about
export const ALLOW_REACTION = '✅';
export const REFUSE_REACTION = '❌';

// A question the harness sent an owner about a call it froze
export interface PendingQuestion {
	readonly pendingCallId: string;
	readonly owner: string;
	// The question asks again about a call whose yes admission kept from running: it supersedes no
	// other request of the room
	readonly again?: true;
}

// What resumes a turn once its owner allowed the call it froze, and where they allowed it: in the
// chat, or through the API
export interface ResumeRequest {
	readonly owner: string;
	readonly roomId: string;
	readonly pendingCallId: string;
	readonly through: 'chat' | 'api';
	// The event of the room that carries the owner's yes, which the resumed turn answers as it would
	// a message: their yes in words, or the request their reaction answered
	readonly replyTo?: string | undefined;
}
