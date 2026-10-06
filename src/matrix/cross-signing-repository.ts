import type { Tx } from '../db/client.js';

export interface CrossSigningRecord {
	readonly owner: string;
	readonly masterPublicKey: string;
}

interface CrossSigningRow {
	owner: string;
	master_public_key: string;
}

export async function findCrossSigning(tx: Tx, owner: string): Promise<CrossSigningRecord | null> {
	const rows = await tx.sql<CrossSigningRow[]>`
		select owner, master_public_key from assistant_cross_signing where owner = ${owner}`;
	const row = rows[0];
	return row === undefined ? null : { owner: row.owner, masterPublicKey: row.master_public_key };
}

export async function saveCrossSigning(tx: Tx, record: CrossSigningRecord): Promise<void> {
	await tx.sql`
		insert into assistant_cross_signing (owner, master_public_key)
		values (${record.owner}, ${record.masterPublicKey})
		on conflict (owner) do update set
			master_public_key = excluded.master_public_key,
			signed_at = now()`;
}
