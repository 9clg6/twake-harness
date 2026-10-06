import type { Tx } from '../db/client.js';

export interface EscrowRecord {
	readonly owner: string;
	readonly path: string;
	readonly masterPublicKey: string;
	readonly backupVersion: string;
	readonly recoveredAt: Date | null;
}

interface EscrowRow {
	owner: string;
	path: string;
	master_public_key: string;
	backup_version: string;
	recovered_at: Date | null;
}

export async function findEscrow(tx: Tx, owner: string): Promise<EscrowRecord | null> {
	const rows = await tx.sql<EscrowRow[]>`
		select owner, path, master_public_key, backup_version, recovered_at
		from assistant_escrow where owner = ${owner}`;
	const row = rows[0];
	return row === undefined
		? null
		: {
				owner: row.owner,
				path: row.path,
				masterPublicKey: row.master_public_key,
				backupVersion: row.backup_version,
				recoveredAt: row.recovered_at
			};
}

export async function saveEscrow(tx: Tx, record: Omit<EscrowRecord, 'recoveredAt'>): Promise<void> {
	await tx.sql`
		insert into assistant_escrow (owner, path, master_public_key, backup_version)
		values (${record.owner}, ${record.path}, ${record.masterPublicKey}, ${record.backupVersion})
		on conflict (owner) do update set
			path = excluded.path,
			master_public_key = excluded.master_public_key,
			backup_version = excluded.backup_version`;
}

export async function markRecovered(tx: Tx, owner: string): Promise<void> {
	await tx.sql`update assistant_escrow set recovered_at = now() where owner = ${owner}`;
}
