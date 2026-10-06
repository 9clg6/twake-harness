import {
	BackupDecryptionKey,
	SecretStorageItems,
	SecretStorageKey
} from '@matrix-org/matrix-sdk-crypto-nodejs';
import type { FastifyBaseLogger } from 'fastify';
import type { Intent } from 'matrix-bot-sdk';

import { withPrincipal, type Db } from '../db/client.js';
import type { EscrowSecrets, EscrowStore } from '../escrow/openbao.js';
import { findEscrow, markRecovered, saveEscrow } from '../escrow/repository.js';
import { machineOf, sendRequest, step } from './crypto-requests.js';

const BACKUP_ALGORITHM = 'm.megolm_backup.v1.curve25519-aes-sha2';
const SECRET_NAMES = [
	'secret_storage_key',
	'secret_storage_key_event_type',
	'secret_storage_key_content',
	'master_key',
	'self_signing_key',
	'user_signing_key',
	'backup_decryption_key',
	'backup_version'
] as const;

type SecretName = (typeof SECRET_NAMES)[number];

export interface EscrowDeps {
	readonly db: Db;
	readonly store: EscrowStore;
	readonly log: FastifyBaseLogger;
}

function requireSecrets(owner: string, secrets: EscrowSecrets): Record<SecretName, string> {
	const found: Partial<Record<SecretName, string>> = {};
	for (const name of SECRET_NAMES) {
		const value = secrets[name];
		if (typeof value !== 'string') throw new Error(`the escrow of ${owner} lacks ${name}`);
		found[name] = value;
	}
	return found as Record<SecretName, string>;
}

// Escrows the identity the assistant holds, which ensureCrossSigning set up: a key backup is
// opened on the homeserver, and the private parts go to OpenBao; the database keeps the path, the
// public key and the backup version only. An escrow describes one identity: a replaced identity
// is escrowed again.
export async function ensureEscrow(
	deps: EscrowDeps,
	intent: Intent,
	owner: string,
	masterPublicKey: string
): Promise<'kept' | 'written'> {
	const { db, store, log } = deps;
	const existing = await withPrincipal(db, { id: owner }, (tx) => findEscrow(tx, owner));
	if (existing !== null && existing.masterPublicKey === masterPublicKey) return 'kept';
	const machine = machineOf(intent);
	const client = intent.underlyingClient;
	const status = await step('reading the cross-signing status', () => machine.crossSigningStatus());
	if (!status.hasMaster || !status.hasSelfSigning) {
		throw new Error('the assistant holds no cross-signing identity to escrow');
	}
	const backupKey = BackupDecryptionKey.createRandomKey();
	const publicKey = backupKey.megolmV1PublicKey.publicKeyBase64;
	const authData: Record<string, unknown> = { public_key: publicKey };
	const signatures = await step('signing the backup', () => machine.sign(JSON.stringify(authData)));
	authData['signatures'] = JSON.parse(signatures.asJSON());
	const created = (await client.doRequest('POST', '/_matrix/client/v3/room_keys/version', null, {
		algorithm: BACKUP_ALGORITHM,
		auth_data: authData
	})) as { version?: string };
	const version = created.version;
	if (typeof version !== 'string') throw new Error('the homeserver opened no key backup');
	await step('enabling the backup', () => machine.enableBackupV1(publicKey, version));
	await step('saving the backup key', () => machine.saveBackupDecryptionKey(backupKey, version));
	const secretKey = SecretStorageKey.createRandomKey();
	const items = await step('exporting the secrets', () =>
		machine.exportSecretsForSecretStorage(secretKey)
	);
	await store.write(owner, {
		secret_storage_key: secretKey.toBase58(),
		secret_storage_key_event_type: secretKey.eventType(),
		secret_storage_key_content: secretKey.accountDataContent(),
		master_key: items.masterKey,
		self_signing_key: items.selfSigningKey,
		user_signing_key: items.userSigningKey,
		backup_decryption_key: backupKey.toBase64(),
		backup_version: version
	});
	await withPrincipal(db, { id: owner }, (tx) =>
		saveEscrow(tx, { owner, path: store.pathOf(owner), masterPublicKey, backupVersion: version })
	);
	log.info(
		{ principal: owner, userId: intent.userId, backupVersion: version },
		'assistant escrowed'
	);
	return 'written';
}

// Puts an assistant back on its escrowed identity: the cross-signing keys come back into the
// device, which signs itself with them, and the key backup goes on under the escrowed key. The
// room keys of a lost store stay in the server backup until the bindings can import them.
export async function recoverFromEscrow(
	deps: EscrowDeps,
	intent: Intent,
	owner: string
): Promise<'recovered' | 'no_escrow'> {
	const { db, store, log } = deps;
	const secrets = await store.read(owner);
	if (secrets === null) return 'no_escrow';
	const found = requireSecrets(owner, secrets);
	const machine = machineOf(intent);
	const secretKey = SecretStorageKey.fromAccountData(
		found.secret_storage_key,
		found.secret_storage_key_event_type,
		found.secret_storage_key_content
	);
	const items = new SecretStorageItems({
		masterKey: found.master_key,
		selfSigningKey: found.self_signing_key,
		userSigningKey: found.user_signing_key
	});
	const signatures = await step('importing the secrets', () =>
		machine.importSecretsFromSecretStorage(secretKey, items)
	);
	await sendRequest(
		intent,
		machine,
		'POST',
		'/_matrix/client/v3/keys/signatures/upload',
		signatures
	);
	const backupKey = BackupDecryptionKey.fromBase64(found.backup_decryption_key);
	const version = found.backup_version;
	await machine.enableBackupV1(backupKey.megolmV1PublicKey.publicKeyBase64, version);
	await machine.saveBackupDecryptionKey(backupKey, version);
	await withPrincipal(db, { id: owner }, (tx) => markRecovered(tx, owner));
	log.info(
		{ principal: owner, userId: intent.userId, backupVersion: version },
		'assistant recovered'
	);
	return 'recovered';
}

// Sends to the backup whatever room keys it does not hold yet
export async function backupRoomKeys(
	deps: EscrowDeps,
	intent: Intent,
	owner: string
): Promise<boolean> {
	const record = await withPrincipal(deps.db, { id: owner }, (tx) => findEscrow(tx, owner));
	if (record === null) return false;
	const machine = machineOf(intent);
	const request = await machine.backupRoomKeys();
	if (request === null) return false;
	await sendRequest(intent, machine, 'PUT', '/_matrix/client/v3/room_keys/keys', request, {
		version: record.backupVersion
	});
	deps.log.info({ principal: owner, backupVersion: record.backupVersion }, 'room keys backed up');
	return true;
}
