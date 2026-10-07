import type { FastifyBaseLogger } from 'fastify';

import type { OwnerDeviceTrust } from '../config.js';
import { withPrincipal, type Db } from '../db/client.js';
import type { DeviceShortfall, Messages, OwnerWordsKind } from '../i18n/messages.js';
import { enqueueJob } from '../jobs/queue.js';
import {
	claimDeviceNotice,
	clearSeen,
	findOwnerCrossSigning,
	pinFirstSeen,
	recordSeen,
	type DeviceNoticeReason
} from './owner-cross-signing-repository.js';
import { readPublishedKeys, senderDevice, type EventSender } from './owner-keys.js';

// How often an owner whose words were not taken from a device is told so again
const REFUSAL_NOTICE_INTERVAL_MS = 60_000;

// The owner's words as they reached their assistant encrypted: a message, or a reaction that
// answers one of the harness's questions
export interface OwnerWords {
	readonly roomId: string;
	readonly owner: string;
	readonly ownerUserId: string;
	readonly assistantUserId: string;
	readonly eventId: string;
	readonly via: OwnerWordsKind;
	// The event as it arrived, still encrypted, null when it was not kept
	readonly encrypted: Record<string, unknown> | null;
}

// The owner's identity as published, against the one the harness holds for them: the same one,
// held already or seen for the first time just now, another one, or none on either side
type IdentityState = 'pinned' | 'first_seen' | 'changed' | 'none';

// Why a device falls short, as the owner is told and as the notices are counted
const SHORTFALLS: Readonly<Record<DeviceShortfall, DeviceNoticeReason>> = {
	unverified: 'unverified',
	no_identity: 'no_identity',
	changed: 'identity_changed'
};

interface DeviceVerdict {
	readonly deviceId: string | null;
	// What the notices are counted by: the device, or the key it sent the room key with when the
	// device is not known
	readonly device: string;
	// Whether the owner's identity, as published, signed the device
	readonly signed: boolean;
	readonly identity: IdentityState;
}

// An event the assistant's encryption engine decrypted for the check: who encrypted it, and what it
// says, which are the words that count
export interface CheckedEvent {
	readonly sender: EventSender;
	readonly event: Record<string, unknown>;
}

// Whether the owner's words count, and then the event to act on: the one the check decrypted, or
// null when the check could not decrypt it, which only report mode takes all the same
export type Admission =
	| { readonly admitted: false }
	| { readonly admitted: true; readonly event: Record<string, unknown> | null };

const REFUSED: Admission = { admitted: false };

export interface OwnerDeviceGateDeps {
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	readonly mode: OwnerDeviceTrust;
	// Decrypts the event again with the assistant's encryption engine, which tells who encrypted it
	decrypt(
		assistantUserId: string,
		roomId: string,
		encrypted: Record<string, unknown> | null
	): Promise<CheckedEvent>;
	// The homeserver's answer to a keys query for the owner, made as their assistant
	queryKeys(assistantUserId: string, ownerUserId: string): Promise<unknown>;
	fetchMessages(owner: string): Promise<Messages>;
}

export interface OwnerDeviceGate {
	// Whether the owner's words count: in enforce mode only when the device that encrypted them is
	// signed by the identity the harness holds for the owner, in report mode always. Either way the
	// device is logged without the words, and the owner is told when it falls short.
	admit(words: OwnerWords): Promise<Admission>;
}

export function makeOwnerDeviceGate(deps: OwnerDeviceGateDeps): OwnerDeviceGate {
	const { db, log, mode } = deps;

	async function judge(words: OwnerWords, sender: EventSender): Promise<DeviceVerdict> {
		const { owner, ownerUserId } = words;
		const keys = readPublishedKeys(
			await deps.queryKeys(words.assistantUserId, ownerUserId),
			ownerUserId
		);
		const found = senderDevice(sender, keys, ownerUserId);
		// The first identity seen is held; another one is kept aside, for the owner to accept it
		const identity = await withPrincipal(db, { id: owner }, async (tx): Promise<IdentityState> => {
			const held = await findOwnerCrossSigning(tx, owner);
			if (held === null) {
				if (keys.masterKey === null) return 'none';
				const pinned = await pinFirstSeen(tx, owner, keys.masterKey);
				if (pinned.masterPublicKey === keys.masterKey) {
					return pinned.pinnedNow ? 'first_seen' : 'pinned';
				}
			} else if (held.masterPublicKey === keys.masterKey) {
				if (held.seen !== null) await clearSeen(tx, owner);
				return 'pinned';
			}
			await recordSeen(tx, owner, keys.masterKey);
			return 'changed';
		});
		return {
			deviceId: found.deviceId,
			device: found.deviceId ?? sender.curve25519Key ?? 'unknown',
			signed: found.signed,
			identity
		};
	}

	// Tells the owner in the room, once a minute at most per device when their words were not
	// taken, and once per device when they were all the same. Whether the owner could be told never
	// changes whether their words count.
	async function tell(
		words: OwnerWords,
		device: string,
		reason: DeviceNoticeReason,
		text: (messages: Messages) => string
	): Promise<void> {
		const { owner, roomId, eventId } = words;
		try {
			const claimed = await withPrincipal(db, { id: owner }, (tx) =>
				claimDeviceNotice(
					tx,
					owner,
					device,
					reason,
					mode === 'enforce' ? REFUSAL_NOTICE_INTERVAL_MS : null
				)
			);
			if (!claimed) return;
			const messages = await deps.fetchMessages(owner);
			await enqueueJob(db, {
				kind: 'send',
				payload: { asUserId: words.assistantUserId, roomId, text: text(messages) },
				dedupKey: `device-notice:${eventId}`,
				groupKey: `send:${roomId}`
			});
		} catch (err: unknown) {
			log.error({ roomId, owner, eventId, reason, mode, err }, 'owner device notice failed');
		}
	}

	return {
		admit: async (words) => {
			const { roomId, owner, eventId, via } = words;
			let checked: CheckedEvent | null = null;
			let verdict: DeviceVerdict;
			try {
				checked = await deps.decrypt(words.assistantUserId, roomId, words.encrypted);
				verdict = await judge(words, checked.sender);
			} catch (err: unknown) {
				log.error({ roomId, owner, eventId, via, mode, err }, 'owner device check failed');
				if (mode === 'report') return { admitted: true, event: checked?.event ?? null };
				await tell(words, '*', 'check_failed', (messages) => messages.notices.turnFailed);
				return REFUSED;
			}
			const admitted: Admission = { admitted: true, event: checked.event };
			const matchesPin = verdict.identity === 'pinned' || verdict.identity === 'first_seen';
			const fields = {
				roomId,
				owner,
				eventId,
				via,
				mode,
				deviceId: verdict.deviceId,
				signed: verdict.signed,
				identity: verdict.identity,
				matchesPin
			};
			if (verdict.signed && matchesPin) {
				log.info(fields, 'owner device verified');
				return admitted;
			}
			const shortfall: DeviceShortfall =
				verdict.identity === 'changed'
					? 'changed'
					: verdict.identity === 'none'
						? 'no_identity'
						: 'unverified';
			const reason = SHORTFALLS[shortfall];
			if (mode === 'report') {
				log.info(fields, 'owner device unverified');
				await tell(words, verdict.device, reason, (m) => m.ownerDevices.reported(shortfall));
				return admitted;
			}
			log.info(fields, 'assistant ignored an unverified device');
			await tell(words, verdict.device, reason, (m) => m.ownerDevices.refused(via, shortfall));
			return REFUSED;
		}
	};
}
