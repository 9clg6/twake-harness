// A contract call reads its application for a GET contract and writes it otherwise; an owner
// allows each level of each application on its own
export type ConsentLevel = 'read' | 'write';

export function isConsentLevel(value: unknown): value is ConsentLevel {
	return value === 'read' || value === 'write';
}

// Why a call waits for its owner: an application they never allowed at that level; a write that a
// turn an event started prepared, or a high-risk write, which they confirm call by call whatever
// they allowed; or the platform's own permission for their assistant to act for them, which its
// broker lacks. One request asks about every reason that applies.
export type WaitReason = 'consent' | 'event_turn' | 'high_risk' | 'delegation';

export type ConsentSource = 'chat' | 'api' | 'migration';

// The assistant's own feed of workplace events, read without asking: it is how events reach the
// owner in the first place. It is built into the harness, never a consent an owner gives or
// withdraws.
export const FEED_DOMAIN = 'events';

// Whether the harness builds this consent in: every assistant reads its own feed of events
export function isBuiltInConsent(domain: string, level: ConsentLevel): boolean {
	return domain === FEED_DOMAIN && level === 'read';
}

// The reactions by which an owner allows, or refuses, a call the harness asked them about
export const ALLOW_REACTION = '✅';
export const REFUSE_REACTION = '❌';

// A question the harness sent an owner about a call it froze
export interface PendingQuestion {
	readonly pendingCallId: string;
	readonly owner: string;
}

// What resumes a turn once its owner allowed the call it froze, and where they allowed it: in the
// chat, or through the API
export interface ResumeRequest {
	readonly owner: string;
	readonly roomId: string;
	readonly pendingCallId: string;
	readonly through: 'chat' | 'api';
}
