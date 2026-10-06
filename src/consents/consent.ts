// A contract call reads its application for a GET contract and writes it otherwise; an owner
// allows each level of each application on its own
export type ConsentLevel = 'read' | 'write';

export type WaitReason = 'consent';

export type ConsentSource = 'chat' | 'api' | 'migration';

// The reaction by which an owner allows a call the harness asked them about
export const ALLOW_REACTION = '✅';

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
