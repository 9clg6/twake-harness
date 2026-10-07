import type { Tx } from '../db/client.js';

export interface CrossSigningRecord {
	readonly owner: string;
	readonly masterPublicKey: string;
	// The assistant device this identity signed, null until one is
	readonly deviceId: string | null;
	// The identity is escrowed and the store that held it was lost: only the owner's recovery
	// brings it back
	readonly awaitingRecovery: boolean;
}

interface CrossSigningRow {
	owner: string;
	master_public_key: string;
	device_id: string | null;
	awaiting_recovery: boolean;
}

export async function findCrossSigning(tx: Tx, owner: string): Promise<CrossSigningRecord | null> {
	const rows = await tx.sql<CrossSigningRow[]>`
		select owner, master_public_key, device_id, awaiting_recovery
		from assistant_cross_signing where owner = ${owner}`;
	const row = rows[0];
	return row === undefined
		? null
		: {
				owner: row.owner,
				masterPublicKey: row.master_public_key,
				deviceId: row.device_id,
				awaitingRecovery: row.awaiting_recovery
			};
}

export async function saveCrossSigning(tx: Tx, record: CrossSigningRecord): Promise<void> {
	await tx.sql`
		insert into assistant_cross_signing (owner, master_public_key, device_id, awaiting_recovery)
		values (${record.owner}, ${record.masterPublicKey}, ${record.deviceId}, ${record.awaitingRecovery})
		on conflict (owner) do update set
			master_public_key = excluded.master_public_key,
			device_id = excluded.device_id,
			awaiting_recovery = excluded.awaiting_recovery,
			signed_at = now()`;
}
