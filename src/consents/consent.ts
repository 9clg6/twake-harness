// A contract call reads its application for a GET contract and writes it otherwise; an owner
// allows each level of each application on its own
export type ConsentLevel = 'read' | 'write';

// Why a call waits for its owner: an application they never allowed, or the platform's own
// permission for their assistant to act for them, which its broker lacks
export type WaitReason = 'consent' | 'delegation';

// Why the platform's broker refused to act for an owner: they never gave their assistant that
// permission, or the one they gave expired
export type DelegationCode = 'delegation_missing' | 'delegation_expired';

export type ConsentSource = 'chat' | 'api' | 'migration';

// The reactions by which an owner allows, or refuses, a call the harness asked them about
export const ALLOW_REACTION = '✅';
export const REFUSE_REACTION = '❌';

// A question the harness sent an owner about a call it froze
export interface PendingQuestion {
	readonly pendingCallId: string;
	readonly owner: string;
}

// What resumes a turn once its owner allowed the call it froze
export interface ResumeRequest {
	readonly owner: string;
	readonly roomId: string;
	readonly pendingCallId: string;
}
