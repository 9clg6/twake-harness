import type { Tx } from '../db/client.js';

export interface CrossSigningRecord {
	readonly owner: string;
	// The assistant the identity was recorded for; null in rows from before it was kept
	readonly userId: string | null;
	readonly masterPublicKey: string;
	// The assistant device this identity signed, null until one is
	readonly deviceId: string | null;
	// The identity is escrowed and the store that held it was lost: only the owner's recovery
	// brings it back
	readonly awaitingRecovery: boolean;
}

interface CrossSigningRow {
	owner: string;
	user_id: string | null;
	master_public_key: string;
	device_id: string | null;
	awaiting_recovery: boolean;
}

export async function findCrossSigning(tx: Tx, owner: string): Promise<CrossSigningRecord | null> {
	const rows = await tx.sql<CrossSigningRow[]>`
		select owner, user_id, master_public_key, device_id, awaiting_recovery
		from assistant_cross_signing where owner = ${owner}`;
	const row = rows[0];
	return row === undefined
		? null
		: {
				owner: row.owner,
				userId: row.user_id,
				masterPublicKey: row.master_public_key,
				deviceId: row.device_id,
				awaitingRecovery: row.awaiting_recovery
			};
}

export async function saveCrossSigning(tx: Tx, record: CrossSigningRecord): Promise<void> {
	await tx.sql`
		insert into assistant_cross_signing
			(owner, user_id, master_public_key, device_id, awaiting_recovery)
		values (${record.owner}, ${record.userId}, ${record.masterPublicKey}, ${record.deviceId},
			${record.awaitingRecovery})
		on conflict (owner) do update set
			user_id = excluded.user_id,
			master_public_key = excluded.master_public_key,
			device_id = excluded.device_id,
			awaiting_recovery = excluded.awaiting_recovery,
			signed_at = now()`;
}
