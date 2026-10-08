import type {
	CrossSigningBootstrapRequests,
	OlmMachine
} from '@matrix-org/matrix-sdk-crypto-nodejs';
import type { FastifyBaseLogger } from 'fastify';
import type { Intent } from 'matrix-bot-sdk';

import { withPrincipal, type Db } from '../db/client.js';
import { findEscrow } from '../escrow/repository.js';
import type { MatrixAdmin } from './admin.js';
import { findCrossSigning, saveCrossSigning } from './cross-signing-repository.js';
import { machineOf, sendRequest, step } from './crypto-requests.js';

export interface CrossSigningDeps {
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	readonly escrowEnabled: boolean;
	readonly admin: Pick<MatrixAdmin, 'uploadSigningKeys'>;
}

// kept: the identity and this device's signature were already there; signed: this device was
// signed; reset: a new identity replaced none, a foreign one, or a lost one; awaiting_recovery:
// the escrowed identity is on the homeserver and only the owner's recovery brings it back.
export type CrossSigningOutcome = 'kept' | 'signed' | 'reset' | 'awaiting_recovery';

export interface CrossSigningResult {
	readonly outcome: CrossSigningOutcome;
	// The master key the homeserver holds for the assistant once this ran
	readonly masterPublicKey: string | null;
}

export interface CrossSigningView {
	readonly masterPublicKey: string | null;
	readonly selfSigningPublicKey: string | null;
	// Whether the device carries a signature from the self-signing key
	readonly deviceSigned: boolean;
}

interface PublicKeyEntry {
	readonly keys?: Record<string, string>;
}

interface KeysQueryReply {
	readonly device_keys?: Record<
		string,
		Record<string, { readonly signatures?: Record<string, Record<string, string>> }>
	>;
	readonly master_keys?: Record<string, PublicKeyEntry>;
	readonly self_signing_keys?: Record<string, PublicKeyEntry>;
}

function firstKey(entry: PublicKeyEntry | undefined): string | null {
	return Object.values(entry?.keys ?? {})[0] ?? null;
}

// The assistant's identity as its owners' clients see it, from the query they make themselves:
// Twake Chat sends room keys only to the devices the owner of a cross-signing identity signed
export async function fetchCrossSigningView(
	intent: Intent,
	deviceId: string | null
): Promise<CrossSigningView> {
	const userId = intent.userId;
	const reply = (await intent.underlyingClient.doRequest(
		'POST',
		'/_matrix/client/v3/keys/query',
		null,
		{ device_keys: { [userId]: [] } }
	)) as KeysQueryReply;
	const masterPublicKey = firstKey(reply.master_keys?.[userId]);
	const selfSigningPublicKey = firstKey(reply.self_signing_keys?.[userId]);
	const signatures =
		deviceId === null ? {} : (reply.device_keys?.[userId]?.[deviceId]?.signatures?.[userId] ?? {});
	return {
		masterPublicKey,
		selfSigningPublicKey,
		deviceSigned: selfSigningPublicKey !== null && `ed25519:${selfSigningPublicKey}` in signatures
	};
}

// The master public key of the cross-signing upload the machine prepared
function masterKeyOfUpload(uploadSigningKeysReq: string): string {
	const body = JSON.parse(uploadSigningKeysReq) as { master_key?: PublicKeyEntry };
	const key = firstKey(body.master_key);
	if (key === null) throw new Error('the cross-signing upload carries no master key');
	return key;
}

// Uploads the identity the machine prepared with this device's signature. The cross-signing keys
// go as the application service, which Synapse lets replace an identity without interactive
// authentication; the device's own token, which the SDK speaks with, could not.
async function uploadIdentity(
	admin: CrossSigningDeps['admin'],
	intent: Intent,
	machine: OlmMachine,
	requests: CrossSigningBootstrapRequests
): Promise<void> {
	if (requests.uploadKeysReq !== undefined && requests.uploadKeysReq !== null) {
		await sendRequest(
			intent,
			machine,
			'POST',
			'/_matrix/client/v3/keys/upload',
			requests.uploadKeysReq
		);
	}
	await step('uploading the cross-signing keys', () =>
		admin.uploadSigningKeys(intent.userId, JSON.parse(requests.uploadSigningKeysReq))
	);
	await sendRequest(
		intent,
		machine,
		'POST',
		'/_matrix/client/v3/keys/signatures/upload',
		requests.uploadSignaturesReq
	);
}

// One run at a time per assistant: the start of the role and a pending answer may both reach an
// assistant, and two resets would hand its owners two identities in a row
const running = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
	const previous = running.get(key);
	const current = (async (): Promise<T> => {
		if (previous !== undefined) await previous.catch(() => undefined);
		return run();
	})();
	running.set(key, current);
	try {
		return await current;
	} finally {
		if (running.get(key) === current) running.delete(key);
	}
}

// Every assistant device carries a signature from the assistant's own cross-signing identity,
// which the harness holds: an identity the harness does not hold is replaced, unless it is the
// escrowed one, which the owner brings back through the recovery.
export function ensureCrossSigning(
	deps: CrossSigningDeps,
	intent: Intent,
	owner: string
): Promise<CrossSigningResult> {
	return oneAtATime(intent.userId, () => crossSign(deps, intent, owner));
}

async function crossSign(
	deps: CrossSigningDeps,
	intent: Intent,
	owner: string
): Promise<CrossSigningResult> {
	const { db, log, escrowEnabled } = deps;
	const machine = machineOf(intent);
	const userId = intent.userId;
	const deviceId = intent.underlyingClient.crypto?.clientDeviceId ?? null;
	const status = await step('reading the cross-signing status', () => machine.crossSigningStatus());
	const holdsIdentity = status.hasMaster && status.hasSelfSigning;
	const view = await step('querying the identity', () => fetchCrossSigningView(intent, deviceId));
	const recorded = await withPrincipal(db, { id: owner }, (tx) => findCrossSigning(tx, owner));
	const escrowed = escrowEnabled
		? await withPrincipal(db, { id: owner }, (tx) => findEscrow(tx, owner))
		: null;
	const ours = [recorded?.masterPublicKey, escrowed?.masterPublicKey];
	const serverKey = view.masterPublicKey;
	// The identity recorded as ours, with the device it signed once it did: a device that is not
	// signed is recorded as none, since the owner's clients would not trust it
	let current = recorded;
	async function record(
		masterPublicKey: string,
		signedDeviceId: string | null,
		awaitingRecovery = false
	): Promise<void> {
		if (
			current?.userId === userId &&
			current.masterPublicKey === masterPublicKey &&
			current.deviceId === signedDeviceId &&
			current.awaitingRecovery === awaitingRecovery
		) {
			return;
		}
		const next = { owner, userId, masterPublicKey, deviceId: signedDeviceId, awaitingRecovery };
		await withPrincipal(db, { id: owner }, (tx) => saveCrossSigning(tx, next));
		current = next;
	}

	if (holdsIdentity && serverKey !== null && ours.includes(serverKey)) {
		if (view.deviceSigned) {
			await record(serverKey, deviceId);
			return { outcome: 'kept', masterPublicKey: serverKey };
		}
		await record(serverKey, null);
		// Uploading the identity the machine holds again signs this device with it
		const requests = await step('signing this device', () => machine.bootstrapCrossSigning(false));
		await uploadIdentity(deps.admin, intent, machine, requests);
		await record(serverKey, deviceId);
		log.info({ owner, userId, deviceId }, 'assistant device cross-signed');
		return { outcome: 'signed', masterPublicKey: serverKey };
	}
	if (!holdsIdentity && escrowed !== null && serverKey === escrowed.masterPublicKey) {
		// No device of this store is signed until the owner's recovery brings the identity back, which
		// a provisioner is told
		await record(current?.masterPublicKey ?? serverKey, null, true);
		log.warn(
			{ owner, userId, deviceId },
			'cross-signing identity escrowed, waiting for its recovery'
		);
		return { outcome: 'awaiting_recovery', masterPublicKey: serverKey };
	}
	const requests = await step('bootstrapping cross-signing', () =>
		machine.bootstrapCrossSigning(true)
	);
	const masterPublicKey = masterKeyOfUpload(requests.uploadSigningKeysReq);
	await uploadIdentity(deps.admin, intent, machine, requests);
	await record(masterPublicKey, deviceId);
	log.info(
		{ owner, userId, deviceId, replaced: serverKey !== null },
		'cross-signing identity reset'
	);
	return { outcome: 'reset', masterPublicKey };
}
