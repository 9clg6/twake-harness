// A contract call reads its application for a GET contract and writes it otherwise; an owner
// allows each level of each application on its own
export type ConsentLevel = 'read' | 'write';

export type WaitReason = 'consent';

export type ConsentSource = 'chat' | 'api' | 'migration';

// The reaction by which an owner allows a call the harness asked them about
export const ALLOW_REACTION = '✅';
