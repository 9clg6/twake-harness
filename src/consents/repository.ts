import type { Tx } from '../db/client.js';
import type { ConsentLevel, ConsentSource, WaitReason } from './consent.js';

export async function hasConsent(
	tx: Tx,
	owner: string,
	domain: string,
	level: ConsentLevel
): Promise<boolean> {
	const rows = await tx.sql`
		select 1 from consents where owner = ${owner} and domain = ${domain} and level = ${level}`;
	return rows.length > 0;
}

export async function grantConsent(
	tx: Tx,
	owner: string,
	domain: string,
	level: ConsentLevel,
	source: ConsentSource
): Promise<void> {
	await tx.sql`
		insert into consents (owner, domain, level, granted_by)
		values (${owner}, ${domain}, ${level}, ${source})
		on conflict do nothing`;
}

export interface PendingCallInput {
	readonly owner: string;
	readonly tool: string;
	readonly contract: string;
	readonly domain: string;
	readonly level: ConsentLevel;
	readonly reasons: readonly WaitReason[];
	readonly arguments: unknown;
	readonly correlationId: string | null;
}

// Freezes a call until its owner answers; resolves to its id
export async function insertPendingCall(tx: Tx, input: PendingCallInput): Promise<string> {
	const rows = await tx.sql<{ id: string }[]>`
		insert into pending_calls (owner, tool, contract, domain, level, reasons, arguments, correlation_id)
		values (${input.owner}, ${input.tool}, ${input.contract}, ${input.domain}, ${input.level},
			${JSON.stringify(input.reasons)}::jsonb, ${JSON.stringify(input.arguments)}::jsonb,
			${input.correlationId})
		returning id`;
	const row = rows[0];
	if (row === undefined) throw new Error('the pending call was not stored');
	return row.id;
}
