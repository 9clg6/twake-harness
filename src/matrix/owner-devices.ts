import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';

import type { OwnerDeviceTrust } from '../config.js';
import { withPrincipal, type Db } from '../db/client.js';
import type {
	DeviceShortfall,
	IdentityReport,
	Messages,
	OwnerWordsKind
} from '../i18n/messages.js';
import { enqueueJob } from '../jobs/queue.js';
import type { IdentityQuestions } from './identity-questions.js';
import {
	claimDeviceNotice,
	clearSeen,
	findOwnerCrossSigning,
	pinFirstSeen,
	receiveWords,
	recordSeen,
	seeSession,
	type DeviceNoticeReason,
	type OwnerCrossSigning
} from './owner-cross-signing-repository.js';
import { readPublishedKeys, senderDevice, type EventSender } from './owner-keys.js';

// How often an owner whose words were not taken from a device is told so again
const REFUSAL_NOTICE_INTERVAL_MS = 60_000;

// How long the words an owner sent are remembered, so that a copy of them starts nothing
const WORDS_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

// The Megolm session of encrypted words, and what tells them from any other words, whatever event
// carries them: a digest of their session and their ciphertext, read as bytes
function sealOf(
	encrypted: Record<string, unknown> | null
): { readonly sessionId: string; readonly digest: string } | null {
	const content: unknown = encrypted?.['content'];
	if (typeof content !== 'object' || content === null) return null;
	const sessionId: unknown = Reflect.get(content, 'session_id');
	const ciphertext: unknown = Reflect.get(content, 'ciphertext');
	if (typeof sessionId !== 'string' || typeof ciphertext !== 'string') return null;
	const digest = createHash('sha256')
		.update(sessionId)
		.update('\0')
		.update(Buffer.from(ciphertext, 'base64'))
		.digest('hex');
	return { sessionId, digest };
}

// Whom the owner's words went to: their assistant, in a room where it asks them questions to answer
// yes or no, or the creator
export type OwnerConversation = 'assistant' | 'creator';

// The owner's words as they reached their assistant encrypted: a message, or a reaction that
// answers one of the harness's questions
export interface OwnerWords {
	readonly roomId: string;
	readonly owner: string;
	readonly ownerUserId: string;
	readonly assistantUserId: string;
	readonly eventId: string;
	readonly via: OwnerWordsKind;
	readonly conversation: OwnerConversation;
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
	// The owner's identity as published, by its public master key, null when they publish none
	readonly masterKey: string | null;
}

// An event the assistant's encryption engine decrypted for the check: who encrypted it, and what it
// says, which are the words that count
export interface CheckedEvent {
	readonly sender: EventSender;
	readonly event: Record<string, unknown>;
}

// Where an owner's words came in clear: in a room of their assistant that reads as clear, or to
// the creator, which takes encrypted commands only
export type UnencryptedReason = 'clear room' | 'unencrypted';

// Whether the owner's words count, and then the event to act on: the one the check decrypted
export type Admission =
	| { readonly admitted: false }
	| { readonly admitted: true; readonly event: Record<string, unknown> };

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
	// Where the owner is asked whether they reset their identity themselves
	readonly questions: Pick<IdentityQuestions, 'ask'>;
	// Whether the owner has an assistant, whose room asks them about a new identity of theirs
	hasAssistant(owner: string): Promise<boolean>;
}

export interface OwnerDeviceGate {
	// Whether the owner's words count: in enforce mode only when the device that encrypted them is
	// signed by the identity the harness holds for the owner, unless it holds that one by their yes
	// in the chat alone; in report mode always. Either way the device is logged without the words,
	// and the owner is told when it falls short.
	admit(words: OwnerWords): Promise<Admission>;
	// Whether the owner's words that came in clear count: never in enforce mode, where the owner is
	// told, and as before in report mode; the reason says where they came in clear
	admitUnencrypted(words: OwnerWords, reason: UnencryptedReason): Promise<boolean>;
}

export function makeOwnerDeviceGate(deps: OwnerDeviceGateDeps): OwnerDeviceGate {
	const { db, log, mode } = deps;

	// Whether the identity held counts as the owner's: one they said yes to in the chat counts only
	// while the deployment reports, as no message confirms an identity where it enforces; there it
	// waits, as any other one, for the owner to accept it through the API
	function counts(held: OwnerCrossSigning): boolean {
		return mode === 'report' || held.pinnedBy !== 'chat';
	}

	async function judge(words: OwnerWords, sender: EventSender): Promise<DeviceVerdict> {
		const { owner, ownerUserId } = words;
		const keys = readPublishedKeys(
			await deps.queryKeys(words.assistantUserId, ownerUserId),
			ownerUserId
		);
		const found = senderDevice(sender, keys, ownerUserId);
		// The first identity seen is held. Another one is kept aside for the owner to accept, once it
		// signed the session their words came from, and so is the one held when it does not count
		const identity = await withPrincipal(db, { id: owner }, async (tx): Promise<IdentityState> => {
			const held = await findOwnerCrossSigning(tx, owner);
			if (held === null) {
				if (keys.masterKey === null) return 'none';
				const pinned = await pinFirstSeen(tx, owner, keys.masterKey);
				if (pinned.masterPublicKey === keys.masterKey) {
					return pinned.pinnedNow ? 'first_seen' : 'pinned';
				}
			} else if (held.masterPublicKey === keys.masterKey && counts(held)) {
				if (held.seen !== null) await clearSeen(tx, owner);
				return 'pinned';
			}
			if (found.signed && keys.masterKey !== null) await recordSeen(tx, owner, keys.masterKey);
			return 'changed';
		});
		return {
			deviceId: found.deviceId,
			device: found.deviceId ?? sender.curve25519Key ?? 'unknown',
			signed: found.signed,
			identity,
			masterKey: keys.masterKey
		};
	}

	// Tells the owner in the room: once a minute at most per device when their words were not
	// taken, in either mode, so that words refused again are told again; once per device when they
	// were taken all the same. Whether the owner could be told never changes whether their words
	// count.
	async function tell(
		words: OwnerWords,
		device: string,
		reason: DeviceNoticeReason,
		taken: boolean,
		text: (messages: Messages) => string
	): Promise<void> {
		const { owner, roomId, eventId } = words;
		try {
			const claimed = await withPrincipal(db, { id: owner }, (tx) =>
				claimDeviceNotice(tx, owner, device, reason, taken ? null : REFUSAL_NOTICE_INTERVAL_MS)
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

	// Why the owner is told about the identity that is not the one held, whose session their words
	// came from: null when their assistant asked them whether they reset it themselves instead, or
	// waits for their answer
	async function identityReport(
		words: OwnerWords,
		verdict: DeviceVerdict
	): Promise<IdentityReport | null> {
		const { roomId, owner, eventId, assistantUserId } = words;
		// Only an assistant asks, in its room: the creator sends the owner there when they have one
		if (words.conversation === 'creator') {
			return (await deps.hasAssistant(owner)) ? 'assistant_asks' : 'no_assistant';
		}
		// It asks only about the identity that signed the session the words came from
		if (!verdict.signed || verdict.masterKey === null) return 'unsigned';
		const question = await deps.questions.ask(
			{ roomId, owner, assistantUserId },
			eventId,
			verdict.masterKey
		);
		// The owner told it they did not reset that identity: what they write with it is still
		// reported to them, until the question expires and is asked again
		return question === 'denied' ? 'denied' : null;
	}

	// The owner's words came from a session of another identity than the one held, the deployment
	// only reporting: their assistant asks them whether they reset it themselves, or they are told
	// what they can do about it, never to accept it through the API, which only a deployment that
	// enforces needs. Whether they could be asked or told never changes whether their words count.
	async function reportIdentity(words: OwnerWords, verdict: DeviceVerdict): Promise<void> {
		const { roomId, owner, eventId } = words;
		const report = await identityReport(words, verdict).catch((err: unknown) => {
			log.error({ roomId, owner, eventId, mode, err }, 'owner identity report failed');
			return null;
		});
		if (report === null) return;
		await tell(words, verdict.device, 'identity_changed', true, (m) =>
			m.ownerDevices.reportedIdentity(report)
		);
	}

	return {
		admit: async (words) => {
			const { roomId, owner, eventId, via } = words;
			// The words as the check decrypted them, once it knew them for new words
			let fresh: CheckedEvent | null = null;
			let verdict: DeviceVerdict;
			try {
				// Words that cannot be told apart from others cannot be checked at all
				const seal = sealOf(words.encrypted);
				if (seal === null) throw new Error('the encrypted words cannot be told apart');
				// The same encrypted words under another event are no new words, whatever the mode
				const copyOf = await withPrincipal(db, { id: owner }, (tx) =>
					receiveWords(tx, owner, seal.digest, eventId, WORDS_KEPT_MS)
				);
				if (copyOf !== null) {
					log.info(
						{ roomId, owner, eventId, via, mode, firstEventId: copyOf },
						'assistant ignored a copy of earlier words'
					);
					return REFUSED;
				}
				const checked = await deps.decrypt(words.assistantUserId, roomId, words.encrypted);
				// Nor are the words of a session whose first words the check decrypted longer ago than
				// copies are remembered, whatever the mode: a session counts from there
				const old = await withPrincipal(db, { id: owner }, (tx) =>
					seeSession(tx, owner, seal.sessionId, WORDS_KEPT_MS)
				);
				if (old) {
					const { deviceId, curve25519Key } = checked.sender;
					log.info(
						{ roomId, owner, eventId, via, mode, deviceId },
						'assistant ignored words of an old session'
					);
					await tell(words, deviceId ?? curve25519Key ?? 'unknown', 'old_session', false, (m) =>
						m.ownerDevices.oldSession(via)
					);
					return REFUSED;
				}
				fresh = checked;
				verdict = await judge(words, checked.sender);
			} catch (err: unknown) {
				log.error({ roomId, owner, eventId, via, mode, err }, 'owner device check failed');
				// Report mode takes the words only once the check decrypted them and knew them for new
				// words, whatever it found after
				if (mode === 'report' && fresh !== null) return { admitted: true, event: fresh.event };
				await tell(words, '*', 'check_failed', false, (messages) => messages.notices.turnFailed);
				return REFUSED;
			}
			const admitted: Admission = { admitted: true, event: fresh.event };
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
				if (shortfall === 'changed') {
					await reportIdentity(words, verdict);
				} else {
					await tell(words, verdict.device, reason, true, (m) =>
						m.ownerDevices.reported(shortfall)
					);
				}
				return admitted;
			}
			log.info(fields, 'assistant ignored an unverified device');
			await tell(words, verdict.device, reason, false, (m) =>
				m.ownerDevices.refused(via, shortfall)
			);
			return REFUSED;
		},
		admitUnencrypted: async (words, reason) => {
			const { roomId, owner, eventId } = words;
			const fields = { roomId, owner, eventId, mode, reason };
			if (mode === 'report') {
				log.info(fields, 'owner message unencrypted');
				return true;
			}
			log.info(fields, 'assistant ignored an unencrypted message');
			await tell(words, '*', 'unencrypted', false, (m) => m.ownerDevices.unencrypted);
			return false;
		}
	};
}
