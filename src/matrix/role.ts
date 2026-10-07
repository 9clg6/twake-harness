import { mkdirSync } from 'node:fs';
import { Server, type IncomingMessage, type ServerResponse } from 'node:http';
import {
	EncryptedRoomEvent,
	type Intent,
	type Appservice,
	getRequestFn,
	LogService,
	RustSdkAppserviceCryptoStorageProvider,
	setRequestFn,
	type MatrixEvent
} from 'matrix-bot-sdk';
import { RoomId, ShieldStateCode, StoreType } from '@matrix-org/matrix-sdk-crypto-nodejs';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

import { fetchOwnerMessages, localeOf } from '../assistants/locale.js';
import { readIdentity } from '../assistants/provisioning.js';
import {
	clearAssistantRoomId,
	findAssistant,
	findDialog,
	listActiveAssistants,
	listProvisionedWithoutRoom,
	saveDialog,
	setAssistantRoomId
} from '../assistants/repository.js';
import { reactionAnswer } from '../consents/answers.js';
import type { PendingQuestion } from '../consents/consent.js';
import { makeConsentMetrics } from '../consents/metrics.js';
import { findRequest } from '../consents/repository.js';
import { enqueueJob } from '../jobs/queue.js';
import { startJobWorker, type JobWorker } from '../jobs/worker.js';
import { makeAssistantService, type AssistantService } from '../assistants/service.js';
import type { Config } from '../config.js';
import { withPrincipal, type Db } from '../db/client.js';
import { getMessages, type Messages } from '../i18n/messages.js';
import { ORGANIZATION_PRINCIPAL } from '../principals/principal.js';
import { matrixUserIdOfPrincipal, principalOfMatrixUser } from '../principals/identity.js';
import { makeMatrixAdmin } from './admin.js';
import { announceCommands, commandOf } from './commands.js';
import { makeOpenBaoEscrow } from '../escrow/openbao.js';
import { makeEnsureEncryption, routeEncryptionSetups } from './encryption.js';
import { backupRoomKeys, ensureEscrow, recoverFromEscrow, type EscrowDeps } from './escrow.js';
import {
	ensureCrossSigning,
	type CrossSigningDeps,
	type CrossSigningResult
} from './cross-signing.js';
import { helpText, runCreatorTurn, type CreatorTurn } from './creator.js';
import { machineOf } from './crypto-requests.js';
import { installRejectionGuard } from './last-resort.js';
import { makeListenerGuard, makeWorkTracker } from './listeners.js';
import { buildRegistration, creatorUserId, isAssistantUserId } from './registration.js';
import { makeChatFeedback, type TurnOutcome, type TurnRef } from './feedback.js';
import { makeConsentRequests } from './consent-requests.js';
import { makeLaidOutText, makeRichText } from './format.js';
import { ensureOrgAgent, isOrgMember, orgAgentUserId, orgGreeting } from './org.js';
import { makeOwnerDeviceGate, type CheckedEvent, type OwnerWords } from './owner-devices.js';
import { makePushedAppservice, PUSH_DEADLINE_MS } from './pushes.js';
import { makeAppserviceStorage } from './storage.js';

// The SDK caches the intent it acts as a user through, and makes a new one an hour after the last,
// however busy the user is. The old intent is never released: its encryption stays subscribed to the
// events of every room, on the same store as the new one's. Each hour, every assistant and the creator
// then set their encryption up again, as often as not inside a push, and kept one more encryption
// machine. An intent lives as long as the role instead: an age no uptime reaches, as the cache takes
// no infinite one, and room for far more users than a deployment has assistants.
const INTENT_MAX_AGE_MS = Number.MAX_SAFE_INTEGER;
const MAX_INTENTS = 10_000;

export interface MatrixRoleOptions {
	readonly config: Config;
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	readonly port: number;
	readonly bindAddress?: string;
	readonly pollIntervalMs?: number;
	// How long the SDK may process a push before the role gives it up, PUSH_DEADLINE_MS by default
	readonly pushDeadlineMs?: number;
	// How long a status message waits for its turn's answer before it gives up, as long as the
	// typing by default
	readonly statusMaxMs?: number;
}

export interface MatrixRole {
	readonly appservice: Appservice;
	readonly creatorUserId: string;
	readonly assistants: AssistantService;
	stop(): Promise<void>;
}

interface RoomEvent {
	readonly type?: string;
	readonly sender?: string;
	readonly state_key?: string;
	readonly event_id?: string;
	readonly content?: Record<string, unknown>;
}

// A message that reached an assistant encrypted, with the encrypted event as it arrived, null when
// it was not kept
interface Encrypted {
	readonly event: Record<string, unknown> | null;
}

// What an owner's message says, as the event whose session was checked says it
interface CheckedWords {
	readonly text: string;
	readonly content: Record<string, unknown> | undefined;
}

// The encrypted events of the pushes under way that the SDK has yet to decrypt, at most
const MAX_ENCRYPTED_IN_FLIGHT = 1_000;

interface SendJob {
	readonly asUserId: string;
	readonly roomId: string;
	readonly text: string;
	// The message the text answers, for the reactions on it: the owner's own, or the assistant's
	// question their reaction answered
	readonly replyTo?: string;
	readonly outcome?: 'answered' | 'failed';
	// The text asks the owner about a frozen call: the event sent is remembered for their answer
	readonly request?: PendingQuestion;
	// The text as HTML, laid out by the harness itself
	readonly html?: string;
	// The turn answered once it reached its limit of tool calls
	readonly atLimit?: true;
}

const recoverPayload = z.object({ owner: z.string().min(1) });
const preparePayload = z.object({ owner: z.string().min(1) });
// The actions a turn has done so far, for its status message
const progressPayload = z.object({
	asUserId: z.string().min(1),
	roomId: z.string().min(1),
	replyTo: z.string().min(1),
	actions: z.number().int().min(1)
});
// How long a stop waits for the pushes and listeners under way before it goes on regardless
const STOP_DRAIN_MS = 10_000;

// A sync that brings the to-device messages and the device lists, and nothing of the rooms
const TO_DEVICE_ONLY_FILTER = JSON.stringify({
	room: {
		timeline: { limit: 0 },
		state: { limit: 0 },
		ephemeral: { limit: 0 },
		account_data: { limit: 0 }
	},
	presence: { limit: 0 },
	account_data: { limit: 0 }
});

interface ToDeviceSync {
	readonly next_batch?: string;
	readonly to_device?: { events?: unknown[] };
	readonly device_one_time_keys_count?: Record<string, number>;
	readonly device_unused_fallback_key_types?: string[];
	readonly device_lists?: { changed?: string[]; left?: string[] };
}

function isSendJob(value: unknown): value is SendJob {
	if (typeof value !== 'object' || value === null) return false;
	const job = value as Record<string, unknown>;
	return (
		typeof job['asUserId'] === 'string' &&
		typeof job['roomId'] === 'string' &&
		typeof job['text'] === 'string' &&
		(job['replyTo'] === undefined || typeof job['replyTo'] === 'string') &&
		(job['outcome'] === undefined ||
			job['outcome'] === 'answered' ||
			job['outcome'] === 'failed') &&
		(job['request'] === undefined || isPendingQuestion(job['request'])) &&
		(job['html'] === undefined || typeof job['html'] === 'string') &&
		(job['atLimit'] === undefined || job['atLimit'] === true)
	);
}

function isPendingQuestion(value: unknown): value is PendingQuestion {
	if (typeof value !== 'object' || value === null) return false;
	const request = value as Record<string, unknown>;
	return typeof request['pendingCallId'] === 'string' && typeof request['owner'] === 'string';
}

function annotationOf(event: RoomEvent): { readonly eventId: string; readonly key: string } | null {
	const relation = event.content?.['m.relates_to'];
	if (typeof relation !== 'object' || relation === null) return null;
	const fields = relation as Record<string, unknown>;
	const eventId = fields['event_id'];
	const key = fields['key'];
	return fields['rel_type'] === 'm.annotation' &&
		typeof eventId === 'string' &&
		typeof key === 'string'
		? { eventId, key }
		: null;
}

// How the turn of a reply ended, as its send job tells it
function outcomeOf(job: SendJob): TurnOutcome {
	if (job.outcome === 'failed') return 'failed';
	return job.atLimit === true ? 'limited' : 'answered';
}

// An encrypted event without the relation its clear part carries: the engine would otherwise take
// that relation for the decrypted event's own when the encrypted content names none, and the event
// an answer is for must be the one the owner's session encrypted
function withoutClearRelation(encrypted: Record<string, unknown>): Record<string, unknown> {
	const content: unknown = encrypted['content'];
	if (typeof content !== 'object' || content === null) return encrypted;
	const { 'm.relates_to': _relation, ...sealed } = content as Record<string, unknown>;
	return { ...encrypted, content: sealed };
}

function turnOf(job: SendJob): TurnRef | null {
	return job.replyTo === undefined
		? null
		: { assistantUserId: job.asUserId, roomId: job.roomId, eventId: job.replyTo };
}

function textOf(event: RoomEvent): string | null {
	const content = event.content ?? {};
	return content['msgtype'] === 'm.text' && typeof content['body'] === 'string'
		? content['body']
		: null;
}

// What an assistant knows of the encryption of one of its rooms
type RoomEncryption = 'encrypted' | 'clear' | 'unreadable';

// The Matrix error code of a failed request, which the SDK carries on what it throws
function errcodeOf(err: unknown): string | null {
	if (typeof err !== 'object' || err === null) return null;
	const errcode: unknown = Reflect.get(err, 'errcode');
	return typeof errcode === 'string' ? errcode : null;
}

export async function startMatrixRole(options: MatrixRoleOptions): Promise<MatrixRole> {
	const { config, db, log } = options;
	const messages = getMessages(config.locale);
	const fetchMessages = (owner: string): Promise<Messages> =>
		fetchOwnerMessages(db, owner, config.locale);
	LogService.setLogger({
		trace: () => undefined,
		debug: () => undefined,
		info: (module: string, ...rest: unknown[]) =>
			process.env['HARNESS_SDK_LOGS'] === '1'
				? log.info({ module, rest }, 'matrix sdk')
				: log.debug({ module, rest }, 'matrix sdk'),
		warn: (module: string, ...rest: unknown[]) => log.warn({ module, rest }, 'matrix sdk'),
		error: (module: string, ...rest: unknown[]) => log.error({ module, rest }, 'matrix sdk')
	});
	const homeserverUrl = new URL('matrix', ensureTrailingSlash(config.apisix.baseUrl)).href;
	// Every call of the SDK goes to APISIX, which admits the harness by its consumer key. The SDK
	// still names the device it acts as with the unstable MSC3202 parameter, which Synapse 1.162
	// dropped: the stable one goes along, so the assistants keep their devices on either side.
	const originalRequest = getRequestFn();
	setRequestFn(
		(
			params: { headers?: Record<string, string>; qs?: Record<string, string> },
			callback: unknown
		) => {
			params.headers = { ...(params.headers ?? {}), apikey: config.apisix.consumerKey };
			const unstableDeviceId = params.qs?.['org.matrix.msc3202.device_id'];
			if (unstableDeviceId !== undefined && params.qs !== undefined) {
				params.qs['device_id'] = unstableDeviceId;
			}
			return originalRequest(params, callback);
		}
	);
	mkdirSync(config.matrix.cryptoStorePath, { recursive: true });
	const storage = makeAppserviceStorage(db);
	// One encryption store per assistant, on the volume of this role
	const cryptoStorage = new RustSdkAppserviceCryptoStorageProvider(
		config.matrix.cryptoStorePath,
		StoreType.Sqlite
	);
	const ensureEncryption = makeEnsureEncryption({
		log,
		storedDeviceId: async (userId) => {
			// What the SDK types as a string is null, or missing, in a store never used
			const stored: string | null | undefined = await cryptoStorage
				.storageForUser(userId)
				.getDeviceId();
			return stored ?? null;
		}
	});
	const appservice = makePushedAppservice(
		{
			port: options.port,
			bindAddress: options.bindAddress ?? '0.0.0.0',
			homeserverName: config.matrix.serverName,
			homeserverUrl,
			// The url only matters to Synapse, which reads it from its own registration file
			registration: buildRegistration(config, ''),
			storage,
			cryptoStorage,
			intentOptions: { maxAgeMs: INTENT_MAX_AGE_MS, maxCached: MAX_INTENTS }
		},
		{ log, storage, ensureEncryption, deadlineMs: options.pushDeadlineMs ?? PUSH_DEADLINE_MS }
	);
	routeEncryptionSetups(appservice, ensureEncryption);
	// What a stop waits for: the listeners under way, and the backups they start
	const inFlight = makeWorkTracker();
	const creator = creatorUserId(config);
	const admin = makeMatrixAdmin({
		apisixBaseUrl: config.apisix.baseUrl,
		consumerKey: config.apisix.consumerKey,
		asToken: config.matrix.asToken
	});
	const assistants = makeAssistantService({ config, db, admin, log });
	const orgUserId = config.org.enabled ? orgAgentUserId(config) : null;
	// The escrow of the assistants' identities in the platform OpenBao, when it is reachable
	const escrow: EscrowDeps | null = config.escrow.enabled
		? { db, store: makeOpenBaoEscrow({ config, log }), log }
		: null;
	const crossSigning: CrossSigningDeps = { db, log, escrowEnabled: escrow !== null, admin };
	// Once an assistant can encrypt: its device is signed by its own cross-signing identity, which
	// Twake Chat requires before it sends the room keys, then that identity is escrowed
	// What the cross-signing came to, null when it failed
	async function onEncryptionReady(
		intent: Intent,
		owner: string
	): Promise<CrossSigningResult | null> {
		log.info(
			{ owner, userId: intent.userId, deviceId: intent.underlyingClient.crypto?.clientDeviceId },
			'encryption ready'
		);
		let signed: CrossSigningResult;
		try {
			signed = await ensureCrossSigning(crossSigning, intent, owner);
		} catch (err: unknown) {
			log.error({ owner, userId: intent.userId, err }, 'cross-signing failed');
			return null;
		}
		if (escrow === null || signed.outcome === 'awaiting_recovery') return signed;
		if (signed.masterPublicKey === null) return signed;
		try {
			await ensureEscrow(escrow, intent, owner, signed.masterPublicKey);
		} catch (err: unknown) {
			log.error({ owner, userId: intent.userId, err }, 'escrow failed');
		}
		return signed;
	}
	function backupInBackground(userId: string, owner: string): void {
		if (escrow === null) return;
		inFlight.track(
			backupRoomKeys(escrow, appservice.getIntentForUserId(userId), owner).catch((err: unknown) => {
				log.warn({ owner, userId, err }, 'room keys backup failed');
			})
		);
	}

	// Synapse checks the application service is alive before it pushes anything (MSC2659).
	appservice.expressAppInstance.post('/_matrix/app/v1/ping', (req, res) => {
		const auth = req.headers.authorization ?? '';
		if (auth !== `Bearer ${config.matrix.hsToken}`) {
			res.status(403).json({ errcode: 'M_FORBIDDEN', error: 'bad token' });
			return;
		}
		res.status(200).json({});
	});
	appservice.expressAppInstance.get('/health', (_req, res) => {
		res.status(200).json({ status: 'ok', role: 'matrix' });
	});

	// A push the SDK fails on no longer ends the role: see installRejectionGuard
	const rejections = installRejectionGuard(log);
	// What this role counts of consent: the owners' answers, and the requests closed unanswered
	const consentMetrics = makeConsentMetrics();
	appservice.expressAppInstance.get('/metrics', (_req, res) => {
		res
			.type('text/plain; version=0.0.4')
			.send(
				[
					'# TYPE harness_unhandled_rejections_total counter',
					`harness_unhandled_rejections_total ${rejections.count}`,
					...consentMetrics.exposition(),
					''
				].join('\n')
			);
	});

	const guard = makeListenerGuard(log, inFlight);

	// Only the creator and the assistants the harness created exist; nothing is made on demand.
	appservice.on('query.user', (userId: string, createUser: (profile: unknown) => void) => {
		log.info({ userId }, 'user query refused');
		createUser(false);
	});

	// The creator answers only in rooms it was invited to; a message can arrive before its join
	// of a fresh invitation has settled, so an invitation counts as presence.
	async function creatorIsInRoom(roomId: string): Promise<boolean> {
		const client = appservice.botIntent.underlyingClient;
		const members = await client.getJoinedRoomMembers(roomId);
		if (members.includes(creator)) return true;
		try {
			await appservice.botIntent.joinRoom(roomId);
			return true;
		} catch {
			return false;
		}
	}

	// The to-device events Synapse pushes, mostly the owners' key shares: which device they target
	appservice.on('ephemeral.event', (event: Record<string, unknown>) => {
		if (event['type'] !== 'm.room.encrypted') return;
		log.info(
			{ toUser: event['to_user_id'], toDevice: event['to_device_id'], sender: event['sender'] },
			'to-device received'
		);
	});

	// Synapse's push of to-device messages (MSC2409) can skip a key share when another to-device
	// message lands at the same instant, while the device's own inbox still holds it: after a failed
	// decryption, the assistant's device fetches what the homeserver kept for it and reads again.
	const syncSince = new Map<string, string>();
	async function fetchMissedKeyShares(userId: string, roomId: string): Promise<number> {
		const intent = appservice.getIntentForUserId(userId);
		await ensureEncryption(intent);
		const client = intent.underlyingClient;
		const since = syncSince.get(userId);
		const sync = (await client.doRequest('GET', '/_matrix/client/v3/sync', {
			timeout: 0,
			filter: TO_DEVICE_ONLY_FILTER,
			...(since === undefined ? {} : { since })
		})) as ToDeviceSync;
		if (typeof sync.next_batch === 'string') syncSince.set(userId, sync.next_batch);
		const events = sync.to_device?.events ?? [];
		// The members' devices are looked up again too: a first sync carries no device lists
		const members = await client.getJoinedRoomMembers(roomId);
		await client.crypto.updateSyncData(
			events as Parameters<typeof client.crypto.updateSyncData>[0],
			sync.device_one_time_keys_count ?? (await lastCounts(userId)),
			(sync.device_unused_fallback_key_types ?? (await lastFallbacks(userId))) as Parameters<
				typeof client.crypto.updateSyncData
			>[2],
			[...new Set([...(sync.device_lists?.changed ?? []), ...members])],
			sync.device_lists?.left ?? []
		);
		return events.length;
	}

	// What the SDK last stored of a device's one-time keys, to hand its crypto a change of device
	// lists without telling it anything false about those keys
	async function lastCounts(userId: string): Promise<Record<string, number>> {
		const raw = await storage.storageForUser?.(userId)?.readValue?.('last_counts');
		return JSON.parse(raw ?? '{}') as Record<string, number>;
	}
	async function lastFallbacks(userId: string): Promise<string[]> {
		const raw = await storage.storageForUser?.(userId)?.readValue?.('last_unused_fallbacks');
		return JSON.parse(raw ?? '[]') as string[];
	}

	// Before an assistant encrypts for a room, its crypto looks the members' devices up again: a
	// device the owner opened since is then given the key, whatever the homeserver pushed about it
	async function refreshMembersDevices(intent: Intent, roomId: string): Promise<void> {
		const client = intent.underlyingClient;
		const members = await client.getJoinedRoomMembers(roomId);
		await client.crypto.updateSyncData(
			[],
			await lastCounts(intent.userId),
			(await lastFallbacks(intent.userId)) as Parameters<typeof client.crypto.updateSyncData>[2],
			members,
			[]
		);
	}

	// The SDK applies a transaction's device list changes only to the users it also carried keys
	// for: every assistant is told here, so an owner's new device gets the next room key
	appservice.on(
		'device_lists',
		guard(
			'device list update',
			async (lists: { changed?: string[]; removed?: string[] }) => {
				const changed = lists.changed ?? [];
				const removed = lists.removed ?? [];
				if (changed.length === 0 && removed.length === 0) return;
				for (const { userId } of await listActiveAssistants(db)) {
					try {
						const intent = appservice.getIntentForUserId(userId);
						await ensureEncryption(intent);
						await intent.underlyingClient.crypto.updateSyncData(
							[],
							await lastCounts(userId),
							(await lastFallbacks(userId)) as Parameters<
								typeof intent.underlyingClient.crypto.updateSyncData
							>[2],
							changed,
							removed
						);
					} catch (err: unknown) {
						log.warn({ userId, err }, 'device list update failed');
					}
				}
			},
			() => ({})
		)
	);

	// The encrypted events of a push as they arrived, until the SDK decrypted them or failed to: the
	// SDK's decrypted event no longer tells which device encrypted it, and an owner's words count
	// only once that device is known
	const encryptedEvents = new Map<string, Record<string, unknown>>();
	appservice.on('room.encrypted_event', (_roomId: string, event: Record<string, unknown>) => {
		const eventId = event['event_id'];
		if (typeof eventId !== 'string') return;
		if (encryptedEvents.size >= MAX_ENCRYPTED_IN_FLIGHT) {
			const oldest = encryptedEvents.keys().next();
			if (oldest.done !== true) encryptedEvents.delete(oldest.value);
		}
		encryptedEvents.set(eventId, event);
	});
	function takeEncrypted(eventId: string | undefined): Record<string, unknown> | null {
		if (eventId === undefined) return null;
		const encrypted = encryptedEvents.get(eventId) ?? null;
		encryptedEvents.delete(eventId);
		return encrypted;
	}

	appservice.on(
		'room.failed_decryption',
		guard(
			'decryption retry',
			async (roomId: string, event: RoomEvent, err: unknown) => {
				// What the SDK hands here is the encrypted event itself
				const encrypted = event as unknown as Record<string, unknown>;
				takeEncrypted(event.event_id);
				log.error(
					{ roomId, sender: event.sender, eventId: event.event_id, err },
					'decryption failed'
				);
				const room = await assistantRoom(roomId);
				if (room === null || event.sender === room.userId) return;
				try {
					const fetched = await fetchMissedKeyShares(room.userId, roomId);
					log.info({ roomId, userId: room.userId, fetched }, 'missed key shares fetched');
					if (fetched === 0) return;
					const intent = appservice.getIntentForUserId(room.userId);
					const decrypted = await intent.underlyingClient.crypto.decryptRoomEvent(
						new EncryptedRoomEvent(encrypted),
						roomId
					);
					// The raw event, as a push hands it: the SDK's wrapper keeps its id under another name,
					// and the message would lose it, with the dedup of its turn and its reactions
					if (decrypted.type === 'm.room.message') {
						await onRoomMessage(roomId, decrypted.raw, { event: encrypted });
					}
					// An answer whose key came late counts like any other
					if (decrypted.type === 'm.reaction')
						await onOwnerAnswer(roomId, decrypted.raw, encrypted);
				} catch (retryErr: unknown) {
					log.warn({ roomId, eventId: event.event_id, err: retryErr }, 'decryption retry failed');
				}
			},
			(roomId: string, event: RoomEvent) => ({
				roomId,
				eventId: event.event_id,
				sender: event.sender
			})
		)
	);

	appservice.on(
		'room.invite',
		guard(
			'invite',
			async (roomId: string, event: RoomEvent) => {
				const invited = event.state_key ?? '';
				if (orgUserId !== null && invited === orgUserId) {
					// The organization agent joins the members of the organization and nobody else
					const inviter = event.sender ?? '';
					if (!isOrgMember(config, inviter)) {
						log.info({ roomId, sender: inviter }, 'organization agent ignored an invite');
						return;
					}
					try {
						const intent = appservice.getIntentForUserId(invited);
						await ensureEncryption(intent);
						await intent.joinRoom(roomId);
					} catch (err: unknown) {
						log.warn({ roomId, invited, err }, 'join failed');
						return;
					}
					await db.sql`
				insert into assistant_rooms (room_id, owner, user_id) values (${roomId}, ${ORGANIZATION_PRINCIPAL}, ${invited})
				on conflict (room_id) do update set owner = excluded.owner, user_id = excluded.user_id`;
					await enqueueJob(db, {
						kind: 'send',
						payload: { asUserId: invited, roomId, text: orgGreeting(config) },
						dedupKey: `welcome:${roomId}`,
						groupKey: `send:${roomId}`
					});
					log.info({ roomId, sender: inviter }, 'organization room opened');
					return;
				}
				if (invited !== creator && !isAssistantUserId(config, invited)) return;
				if (invited !== creator) {
					await onAssistantInvite(roomId, invited, event.sender ?? '');
					return;
				}
				log.info({ roomId, invited, sender: event.sender }, 'invite accepted');
				try {
					const intent = appservice.getIntentForUserId(invited);
					// Key shares for this room may arrive with the next transaction: be ready to receive them
					await ensureEncryption(intent);
					await intent.joinRoom(roomId);
				} catch (err: unknown) {
					log.warn({ roomId, invited, err }, 'join failed');
					return;
				}
				// Synapse delivers nothing sent before the join, so the creator opens the conversation
				// itself rather than let a first message go unanswered.
				if (invited === creator) {
					const owner = principalOfMatrixUser(config, event.sender ?? '');
					const toOwner = owner === null ? messages : await fetchMessages(owner);
					await appservice.botIntent.sendEvent(roomId, makeRichText(helpText(toOwner)));
				}
			},
			(roomId: string, event: RoomEvent) => ({
				roomId,
				eventId: event.event_id,
				sender: event.sender
			})
		)
	);

	// An assistant joins the rooms its own owner invites it to, as the direct room the owner's client
	// opens with it: the room becomes one of its rooms, where it answers its owner, and the first one
	// becomes the room it writes to its owner in. An invitation from anyone else is declined.
	async function onAssistantInvite(
		roomId: string,
		invited: string,
		inviter: string
	): Promise<void> {
		const owner = principalOfMatrixUser(config, inviter);
		const assistant =
			owner === null
				? null
				: await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
		// One assistant answers in a room: a room another one already answers in stays its own
		const holder = await assistantRoom(roomId);
		const declined =
			owner === null ||
			assistant === null ||
			assistant.deletedAt !== null ||
			assistant.userId !== invited
				? 'not_its_owner'
				: holder !== null && holder.userId !== invited
					? 'another_assistant'
					: null;
		if (declined !== null || owner === null || assistant === null) {
			log.info(
				{ roomId, invited, sender: inviter, reason: declined },
				'assistant declined an invite'
			);
			try {
				await appservice.getIntentForUserId(invited).leaveRoom(roomId);
			} catch (err: unknown) {
				log.warn({ roomId, invited, err }, 'invite not declined');
			}
			return;
		}
		log.info({ roomId, invited, sender: inviter }, 'invite accepted');
		const intent = appservice.getIntentForUserId(invited);
		try {
			// Key shares for this room may arrive with the next transaction: be ready to receive them
			await ensureEncryption(intent);
			await intent.joinRoom(roomId);
		} catch (err: unknown) {
			log.warn({ roomId, invited, err }, 'join failed');
			return;
		}
		// For now an assistant works in a direct room only, its owner and itself: everyone else in the
		// room would read what it writes its owner. Its members are read once it is in; a room it cannot
		// read them in is taken for one with others.
		let direct = false;
		try {
			direct = !(await hasOthers(intent, roomId, [
				matrixUserIdOfPrincipal(config, owner) ?? '',
				invited
			]));
		} catch (err: unknown) {
			log.warn({ roomId, invited, err }, 'room members not read');
		}
		if (!direct) {
			log.info(
				{ roomId, invited, sender: inviter, reason: 'not_direct' },
				'assistant declined an invite'
			);
			try {
				await intent.leaveRoom(roomId, (await fetchMessages(owner)).notices.directRoomsOnly);
			} catch (err: unknown) {
				log.warn({ roomId, invited, err }, 'invite not declined');
			}
			return;
		}
		await db.sql`
			insert into assistant_rooms (room_id, owner, user_id) values (${roomId}, ${owner}, ${invited})
			on conflict (room_id) do nothing`;
		if (assistant.roomId === null) {
			await withPrincipal(db, { id: owner }, (tx) => setAssistantRoomId(tx, owner, roomId));
		}
		log.info({ roomId, owner, userId: invited }, 'assistant room opened by its owner');
		await announceCommands(
			{ admin, log },
			{ roomId, assistantUserId: invited },
			await fetchMessages(owner)
		);
	}

	// Whether anyone but these is in the room, joined or invited
	async function hasOthers(
		intent: Intent,
		roomId: string,
		allowed: readonly string[]
	): Promise<boolean> {
		const members = await intent.underlyingClient.getRoomMembers(roomId, undefined, [
			'join',
			'invite'
		]);
		return members.some((member) => !allowed.includes(member.membershipFor));
	}

	// Someone other than its owner came into a room where the assistant answered its owner: it says
	// why there and leaves, and the room is no longer one of its rooms nor the one it writes its owner
	// in. Whatever it said there before stays; nothing more reaches the newcomer.
	async function leaveNoLongerDirect(
		roomId: string,
		owner: string,
		assistantUserId: string
	): Promise<void> {
		const removed = await db.sql`delete from assistant_rooms where room_id = ${roomId}`;
		if (removed.count === 0) return;
		await withPrincipal(db, { id: owner }, (tx) => clearAssistantRoomId(tx, owner, roomId));
		log.info({ roomId, owner, userId: assistantUserId }, 'assistant left a room no longer direct');
		const { notices } = await fetchMessages(owner);
		const intent = appservice.getIntentForUserId(assistantUserId);
		try {
			await ensureEncryption(intent);
			await refreshMembersDevices(intent, roomId);
			await intent.sendEvent(roomId, makeRichText(notices.directRoomsOnly));
		} catch (err: unknown) {
			log.warn({ roomId, err }, 'leave notice not sent');
		}
		try {
			await intent.leaveRoom(roomId, notices.directRoomsOnly);
		} catch (err: unknown) {
			log.warn({ roomId, err }, 'room not left');
		}
	}

	// The rooms of the assistants, kept as an index so a message is routed to its owner first
	async function assistantRoom(
		roomId: string
	): Promise<{ owner: string; userId: string; welcome: string | null } | null> {
		const rows = await db.sql<{ owner: string; user_id: string; welcome: string | null }[]>`
			select owner, user_id, welcome from assistant_rooms where room_id = ${roomId}`;
		const row = rows[0];
		return row === undefined
			? null
			: { owner: row.owner, userId: row.user_id, welcome: row.welcome };
	}

	// A room's encryption, as its assistant's device knows it: the SDK reads the room's
	// m.room.encryption state and keeps it in the assistant's encryption store, since encryption is
	// never turned off, and encrypts what the assistant says in the room by the same knowledge. The
	// SDK takes a state it failed to read for none, so a room it does not hold as encrypted is read
	// again here: only the homeserver's answer that the room has no such state makes it clear.
	async function roomEncryption(assistantUserId: string, roomId: string): Promise<RoomEncryption> {
		const intent = appservice.getIntentForUserId(assistantUserId);
		await ensureEncryption(intent);
		const client = intent.underlyingClient;
		if (await client.crypto.isRoomEncrypted(roomId)) return 'encrypted';
		try {
			await client.getRoomStateEvent(roomId, 'm.room.encryption', '');
			return 'encrypted';
		} catch (err: unknown) {
			return errcodeOf(err) === 'M_NOT_FOUND' ? 'clear' : 'unreadable';
		}
	}

	// Who comes into an assistant's room: anyone but its owner makes it leave, as it answers its owner
	// in a direct room only for now. The owner has joined: their devices are in the room, the greeting
	// can be encrypted for them.
	appservice.on(
		'room.event',
		guard(
			'room event',
			async (roomId: string, event: RoomEvent) => {
				if (event.type !== 'm.room.member') return;
				const membership = event.content?.['membership'];
				if (membership !== 'join' && membership !== 'invite') return;
				const room = await assistantRoom(roomId);
				if (room === null) return;
				const ownerUserId =
					room.owner === ORGANIZATION_PRINCIPAL
						? null
						: matrixUserIdOfPrincipal(config, room.owner);
				if (
					room.owner !== ORGANIZATION_PRINCIPAL &&
					event.state_key !== ownerUserId &&
					event.state_key !== room.userId
				) {
					await leaveNoLongerDirect(roomId, room.owner, room.userId);
					return;
				}
				if (membership !== 'join' || room.welcome === null) return;
				if (event.state_key !== ownerUserId) return;
				const claimed = await db.sql`
			update assistant_rooms set welcome = null where room_id = ${roomId} and welcome is not null`;
				if (claimed.count !== 1) return;
				await enqueueJob(db, {
					kind: 'send',
					payload: { asUserId: room.userId, roomId, text: room.welcome },
					dedupKey: `welcome:${roomId}`
				});
				log.info({ roomId, owner: room.owner }, 'welcome queued');
			},
			(roomId: string, event: RoomEvent) => ({
				roomId,
				eventId: event.event_id,
				sender: event.sender
			})
		)
	);

	// Eyes, typing and, once it takes a while, a status message while a turn works, a check mark
	// once it answered
	const feedback = makeChatFeedback({
		log,
		setTyping: async (userId, roomId, typing, timeoutMs) => {
			await appservice
				.getIntentForUserId(userId)
				.underlyingClient.setTyping(roomId, typing, timeoutMs);
		},
		sendEvent: async (userId, roomId, type, content) => {
			const intent = appservice.getIntentForUserId(userId);
			await ensureEncryption(intent);
			await refreshMembersDevices(intent, roomId);
			return intent.underlyingClient.sendEvent(roomId, type, content);
		},
		redactEvent: async (userId, roomId, eventId) => {
			await appservice.getIntentForUserId(userId).underlyingClient.redactEvent(roomId, eventId);
		},
		// The organization agent speaks the deployment's language with every member
		statusTexts: async (turn) => {
			const room = await assistantRoom(turn.roomId);
			const toOwner =
				room === null || room.owner === ORGANIZATION_PRINCIPAL
					? messages
					: await fetchMessages(room.owner);
			return toOwner.status;
		},
		statusDelayMs: config.turn.statusDelayMs,
		...(options.statusMaxMs === undefined ? {} : { statusMaxMs: options.statusMaxMs })
	});

	// The harness's requests in the assistants' rooms, and the owners' answers to them
	const requests = makeConsentRequests({
		db,
		log,
		fetchMessages,
		lifetimeMs: config.consent.requestLifetimeMs,
		metrics: consentMetrics,
		resumeQueued: (room, eventId) => {
			const { roomId, assistantUserId } = room;
			feedback
				.turnQueued({ assistantUserId, roomId, eventId })
				.catch((err: unknown) => log.warn({ roomId, eventId, err }, 'turn feedback failed'));
		}
	});

	// An event decrypted again by the assistant's encryption engine, which tells who encrypted it
	// where the SDK keeps that to itself, with what it says
	async function decryptChecked(
		assistantUserId: string,
		roomId: string,
		encrypted: Record<string, unknown> | null
	): Promise<CheckedEvent> {
		if (encrypted === null) throw new Error('the encrypted event was not kept');
		const intent = appservice.getIntentForUserId(assistantUserId);
		await ensureEncryption(intent);
		const decrypted = await machineOf(intent).decryptRoomEvent(
			JSON.stringify(withoutClearRelation(encrypted)),
			new RoomId(roomId)
		);
		const shield = decrypted.shieldState(false);
		const event: unknown = JSON.parse(decrypted.event);
		if (typeof event !== 'object' || event === null)
			throw new Error('the decrypted event is no object');
		return {
			sender: {
				userId: decrypted.sender?.toString() ?? null,
				deviceId: decrypted.senderDevice?.toString() ?? null,
				curve25519Key: decrypted.senderCurve25519Key ?? null,
				ed25519Key: decrypted.senderClaimedEd25519Key ?? null,
				unauthenticated:
					shield?.code === ShieldStateCode.AuthenticityNotGuaranteed ||
					shield?.code === ShieldStateCode.MismatchedSender
			},
			event: event as Record<string, unknown>
		};
	}

	// An owner's words count only from a device their cross-signing identity signed, in enforce
	// mode; in report mode they count all the same, and the devices that fall short are reported
	const ownerDevices = makeOwnerDeviceGate({
		db,
		log,
		mode: config.matrix.ownerDeviceTrust,
		fetchMessages,
		decrypt: decryptChecked,
		queryKeys: async (assistantUserId, ownerUserId) => {
			const intent = appservice.getIntentForUserId(assistantUserId);
			await ensureEncryption(intent);
			return intent.underlyingClient.doRequest('POST', '/_matrix/client/v3/keys/query', null, {
				device_keys: { [ownerUserId]: [] }
			});
		}
	});

	// The owner's answer to a request of the harness: a bare ✅ or ❌ on it. Only an event that
	// arrived encrypted, from a device of the owner their identity signed, counts.
	async function onOwnerAnswer(
		roomId: string,
		event: RoomEvent,
		encrypted: Record<string, unknown> | null
	): Promise<void> {
		if (event.type !== 'm.reaction') return;
		const sender = event.sender ?? '';
		// The assistants' own reactions mark the messages they answered
		if (sender === creator || isAssistantUserId(config, sender)) return;
		const annotation = annotationOf(event);
		if (annotation === null) return;
		const says = reactionAnswer(annotation.key);
		if (says === null) return;
		const room = await assistantRoom(roomId);
		if (room === null || room.owner === ORGANIZATION_PRINCIPAL) return;
		const owner = room.owner;
		if (principalOfMatrixUser(config, sender) !== owner) {
			log.info({ roomId, sender, owner }, 'answer ignored: not the owner');
			return;
		}
		// A reaction on anything but one of the harness's questions answers nothing
		const asked = await withPrincipal(db, { id: owner }, (tx) =>
			findRequest(tx, owner, annotation.eventId)
		);
		if (asked === null) return;
		const eventId = event.event_id ?? `${roomId}:${Date.now()}`;
		const words: OwnerWords = {
			roomId,
			owner,
			ownerUserId: sender,
			assistantUserId: room.userId,
			eventId,
			via: 'answer',
			encrypted
		};
		const admission = await ownerDevices.admit(words);
		if (!admission.admitted) return;
		// The answer that counts is the one of the very event whose session was checked
		const checked = admission.event === null ? event : (admission.event as RoomEvent);
		const checkedAnnotation = checked.sender === sender ? annotationOf(checked) : null;
		const checkedSays =
			checked.type === 'm.reaction' && checkedAnnotation !== null
				? reactionAnswer(checkedAnnotation.key)
				: null;
		if (checkedAnnotation === null || checkedSays === null) {
			log.info({ roomId, owner, eventId }, 'answer ignored: not the event checked');
			return;
		}
		await requests.reacted(
			{ roomId, owner, assistantUserId: room.userId },
			checkedAnnotation.eventId,
			checkedSays,
			eventId
		);
	}

	// An owner's encrypted message once its session was checked: the text and content of the very event
	// whose session was checked, a command it names included, null when the message does not count
	async function checkedMessage(words: OwnerWords, raw: RoomEvent): Promise<CheckedWords | null> {
		const admission = await ownerDevices.admit(words);
		if (!admission.admitted) return null;
		const checked = admission.event === null ? raw : (admission.event as RoomEvent);
		const checkedText =
			checked.type === 'm.room.message' && checked.sender === words.ownerUserId
				? textOf(checked)
				: null;
		if (checkedText === null) {
			const { roomId, owner, eventId } = words;
			log.info({ roomId, owner, eventId }, 'message ignored: not the event checked');
			return null;
		}
		return { text: checkedText, content: checked.content };
	}

	// The messages that reached an assistant encrypted, between the SDK's decrypted event and the
	// same event handed on as a room message, with the encrypted event as it arrived: only those may
	// answer a question, or start a turn in an encrypted room
	const decryptedMessages = new Map<string, Record<string, unknown> | null>();

	appservice.on(
		'room.decrypted_event',
		guard(
			'owner answer',
			async (roomId: string, event: RoomEvent) => {
				const encrypted = takeEncrypted(event.event_id);
				if (event.type === 'm.room.message' && event.event_id !== undefined) {
					decryptedMessages.set(event.event_id, encrypted);
				}
				await onOwnerAnswer(roomId, event, encrypted);
			},
			(roomId: string, event: RoomEvent) => ({
				roomId,
				eventId: event.event_id,
				sender: event.sender
			})
		)
	);

	appservice.on(
		'room.message',
		guard(
			'room message',
			(roomId: string, event: MatrixEvent<unknown> | RoomEvent) => {
				const eventId = (event as RoomEvent).event_id ?? '';
				const encrypted: Encrypted | null = decryptedMessages.has(eventId)
					? { event: decryptedMessages.get(eventId) ?? null }
					: null;
				decryptedMessages.delete(eventId);
				return onRoomMessage(roomId, event, encrypted);
			},
			(roomId: string, event: MatrixEvent<unknown> | RoomEvent) => ({
				roomId,
				eventId: (event as RoomEvent).event_id,
				sender: (event as RoomEvent).sender
			})
		)
	);

	async function onRoomMessage(
		roomId: string,
		event: MatrixEvent<unknown> | RoomEvent,
		encrypted: Encrypted | null
	): Promise<void> {
		const raw = event as RoomEvent;
		const sender = raw.sender ?? '';
		log.info({ roomId, sender, eventId: raw.event_id }, 'message received');
		if (sender === creator || isAssistantUserId(config, sender)) return;
		const text = textOf(raw);
		if (text === null) return;
		const room = await assistantRoom(roomId);
		if (room !== null) {
			const eventId = raw.event_id ?? `${roomId}:${Date.now()}`;
			let owner: string;
			let message = text;
			// What names a command: the content of the event whose session was checked, once it was
			let content = raw.content;
			if (room.owner === ORGANIZATION_PRINCIPAL) {
				// The organization agent hears the members only, and is told who is writing
				if (!isOrgMember(config, sender)) {
					log.info({ roomId, sender }, 'organization agent ignored a non-member');
					return;
				}
				owner = ORGANIZATION_PRINCIPAL;
				message = `[${sender}] ${text}`;
			} else {
				// An assistant's room: only its owner is heard, everyone else is ignored and logged
				const principal = principalOfMatrixUser(config, sender);
				if (principal === null || principal !== room.owner) {
					log.info({ roomId, sender, owner: room.owner }, 'assistant ignored a foreign sender');
					return;
				}
				owner = principal;
				if (encrypted !== null) {
					const words: OwnerWords = {
						roomId,
						owner,
						ownerUserId: sender,
						assistantUserId: room.userId,
						eventId,
						via: 'message',
						encrypted: encrypted.event
					};
					const checked = await checkedMessage(words, raw);
					if (checked === null) return;
					message = checked.text;
					content = checked.content;
					const requestRoom = { roomId, owner, assistantUserId: room.userId };
					if (await requests.wrote(requestRoom, eventId, checked.text)) return;
				}
			}
			// In an encrypted room, the devices of the owner, or of the organization's members, encrypt
			// what they write: a message in their name that came in clear was written on the server
			// side, and starts nothing. A room whose encryption cannot be read counts as encrypted, so
			// that a failure of the homeserver lets no such message through.
			if (encrypted === null) {
				const encryption = await roomEncryption(room.userId, roomId);
				if (encryption !== 'clear') {
					log.info(
						{
							roomId,
							sender,
							owner,
							eventId: raw.event_id,
							reason: encryption === 'encrypted' ? 'encrypted room' : 'encryption state unreadable'
						},
						'assistant ignored an unencrypted message'
					);
					return;
				}
				// An owner's assistant opens its rooms encrypted: one that reads as clear takes the
				// owner's words only as long as the deployment only reports
				const unencrypted: OwnerWords = {
					roomId,
					owner,
					ownerUserId: sender,
					assistantUserId: room.userId,
					eventId,
					via: 'message',
					encrypted: null
				};
				if (
					owner !== ORGANIZATION_PRINCIPAL &&
					!(await ownerDevices.admitUnencrypted(unencrypted, 'clear room'))
				) {
					return;
				}
			}
			// A command the assistant announced in its owner's rooms is answered by the harness, not
			// the model; it goes out after what the assistant was already saying in the room. It is
			// read from the words that count: those of the event whose session was checked
			if (owner !== ORGANIZATION_PRINCIPAL && commandOf(message, content) === 'help') {
				const { assistantCommands } = await fetchMessages(owner);
				await enqueueJob(db, {
					kind: 'send',
					payload: { asUserId: room.userId, roomId, text: assistantCommands.help.answer },
					dedupKey: `command:${eventId}`,
					groupKey: `send:${roomId}`
				});
				log.info({ roomId, owner, eventId, command: 'help' }, 'assistant command answered');
				return;
			}
			// The turns of one owner run one after the other, in the order they were sent
			const queued = await enqueueJob(db, {
				kind: 'turn',
				payload: { owner, roomId, eventId, text: message },
				dedupKey: `turn:${eventId}`,
				groupKey: `turn:${owner}`
			});
			log.info({ roomId, owner, eventId }, 'turn queued');
			// A redelivered event makes no second turn, nor a second pair of eyes
			if (queued && raw.event_id !== undefined) {
				feedback
					.turnQueued({ assistantUserId: room.userId, roomId, eventId })
					.catch((err: unknown) => log.warn({ roomId, eventId, err }, 'turn feedback failed'));
			}
			backupInBackground(room.userId, owner);
			return;
		}
		if (!(await creatorIsInRoom(roomId))) return;
		const owner = principalOfMatrixUser(config, sender);
		if (owner === null) {
			log.info({ roomId, sender }, 'creator ignored a foreign sender');
			return;
		}
		// The creator takes an owner's commands as their assistant takes their words: encrypted, from
		// a session their identity signed, as long as the deployment enforces it
		const words: OwnerWords = {
			roomId,
			owner,
			ownerUserId: sender,
			assistantUserId: creator,
			eventId: raw.event_id ?? `${roomId}:${Date.now()}`,
			via: 'message',
			encrypted: encrypted?.event ?? null
		};
		let command = text;
		if (encrypted === null) {
			if (!(await ownerDevices.admitUnencrypted(words, 'unencrypted'))) return;
		} else {
			const checked = await checkedMessage(words, raw);
			if (checked === null) return;
			command = checked.text;
		}
		const state = await withPrincipal(db, { id: owner }, (tx) => findDialog(tx, owner));
		const toOwner = await fetchMessages(owner);
		let turn: CreatorTurn;
		try {
			turn = await runCreatorTurn({ owner, text: command, state }, assistants, toOwner);
		} catch (err: unknown) {
			// The owner is told, and the dialog starts over: one left waiting for a name would take
			// their next message for one
			log.error({ roomId, sender, owner, err }, 'creator turn failed');
			turn = { command: 'failed', nextState: null, reply: toOwner.creator.requestFailed };
		}
		await withPrincipal(db, { id: owner }, (tx) => saveDialog(tx, owner, turn.nextState));
		log.info({ roomId, sender, owner, command: turn.command }, 'creator command');
		await appservice.botIntent.sendEvent(roomId, makeRichText(turn.reply));
	}

	// Answers computed by the api role, sent as the assistant through its intent, which encrypts
	// them when the room is encrypted
	// The owner asked for the escrowed identity back, after a lost store: the (new) device takes
	// the cross-signing keys and the backup key, and the owner is told in the room
	async function recover(owner: string): Promise<void> {
		const assistant = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
		if (assistant === null || assistant.deletedAt !== null) {
			log.info({ owner }, 'recovery dropped: no assistant');
			return;
		}
		if (escrow === null) {
			log.warn({ owner }, 'recovery requested but no escrow is configured');
			return;
		}
		const intent = appservice.getIntentForUserId(assistant.userId);
		await ensureEncryption(intent);
		const result = await recoverFromEscrow(escrow, intent, owner);
		log.info({ owner, userId: assistant.userId, result }, 'recovery done');
		// The device the recovered identity signed is recorded, the wait for the recovery is over: a
		// provisioner hands that device out again
		if (result === 'recovered') await onEncryptionReady(intent, owner);
		if (assistant.roomId === null) return;
		const { notices } = getMessages(localeOf(assistant, config.locale));
		await enqueueJob(db, {
			kind: 'send',
			payload: {
				asUserId: assistant.userId,
				roomId: assistant.roomId,
				text: result === 'recovered' ? notices.recovered : notices.noEscrow
			},
			dedupKey: `recover-notice:${owner}:${Date.now()}`,
			groupKey: `send:${assistant.roomId}`
		});
	}

	// A provisioner asked for the owner's assistant: its device and its identity are made now, since
	// the owner's client checks the identity before it opens the room, rather than when it speaks
	async function prepare(owner: string): Promise<void> {
		const assistant = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
		if (assistant === null || assistant.deletedAt !== null) {
			log.info({ owner }, 'preparation dropped: no assistant');
			return;
		}
		const intent = appservice.getIntentForUserId(assistant.userId);
		await ensureEncryption(intent);
		const signed = await onEncryptionReady(intent, owner);
		// Only the owner's recovery brings an escrowed identity back: preparing again changes nothing
		if (signed?.outcome === 'awaiting_recovery') {
			log.info({ owner, userId: assistant.userId }, 'preparation waits for the recovery');
			return;
		}
		// Not ready, as when the homeserver refused a step: thrown, so that the queue tries again a
		// moment later, rather than leave the assistant unready until its provisioner calls again
		if ((await readIdentity(db, owner, assistant.userId)).state !== 'ready') {
			throw new Error('the assistant identity is not ready yet');
		}
		log.info({ owner, userId: assistant.userId }, 'assistant prepared');
	}

	const sender: JobWorker = startJobWorker({
		db,
		log,
		kinds: ['send', 'recover', 'progress', 'prepare'],
		...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
		handler: async (job) => {
			if (job.kind === 'recover') {
				const parsed = recoverPayload.safeParse(job.payload);
				if (!parsed.success) throw new Error('recover payload is malformed');
				await recover(parsed.data.owner);
				return;
			}
			if (job.kind === 'prepare') {
				const parsed = preparePayload.safeParse(job.payload);
				if (!parsed.success) throw new Error('prepare payload is malformed');
				await prepare(parsed.data.owner);
				return;
			}
			if (job.kind === 'progress') {
				const parsed = progressPayload.safeParse(job.payload);
				// Best effort, as the rest of the feedback: a retry would hold the room's next counts back
				if (!parsed.success) {
					log.warn({ job: job.id }, 'progress payload is malformed');
					return;
				}
				const { asUserId, roomId, replyTo, actions } = parsed.data;
				feedback.turnProgressed({ assistantUserId: asUserId, roomId, eventId: replyTo }, actions);
				return;
			}
			if (!isSendJob(job.payload)) throw new Error('send payload is malformed');
			const intent = appservice.getIntentForUserId(job.payload.asUserId);
			await ensureEncryption(intent);
			const room = await assistantRoom(job.payload.roomId);
			if (room !== null) await onEncryptionReady(intent, room.owner);
			await refreshMembersDevices(intent, job.payload.roomId);
			const turn = turnOf(job.payload);
			const request = job.payload.request;
			// A question's status, if any, points to it before it goes out; any other reply goes out
			// after its status, which then closes
			if (turn !== null) {
				await feedback.answerReady(turn, request === undefined ? 'answer' : 'question');
			}
			const { text, html } = job.payload;
			const sent = await intent.sendEvent(
				job.payload.roomId,
				html === undefined ? makeRichText(text) : makeLaidOutText(text, html)
			);
			log.info({ roomId: job.payload.roomId, asUserId: job.payload.asUserId }, 'answer sent');
			if (request !== undefined) {
				const requestRoom = {
					roomId: job.payload.roomId,
					owner: request.owner,
					assistantUserId: job.payload.asUserId
				};
				await requests.asked(requestRoom, request.pendingCallId, sent);
			}
			if (turn !== null) {
				feedback
					.answerSent(turn, outcomeOf(job.payload))
					.catch((err: unknown) =>
						log.warn({ roomId: turn.roomId, err }, 'answer feedback failed')
					);
			}
			if (room !== null) backupInBackground(room.userId, room.owner);
		}
	});

	if (config.org.enabled) {
		try {
			await ensureOrgAgent({ config, db, admin, log });
		} catch (err: unknown) {
			log.error({ err }, 'organization agent setup failed');
		}
	}
	// Every assistant holds its encryption state from the start, so the key shares Synapse pushes
	// while this role was away, or before an assistant speaks, are not lost
	// The assistants a provisioner asked for, with no room yet, too: their owners' clients check the
	// identity before they open one, and a store lost since would leave the recorded one stale
	const assistantsAtStart = [
		...(await listActiveAssistants(db)),
		...(await listProvisionedWithoutRoom(db))
	];
	for (const { owner, userId } of assistantsAtStart) {
		try {
			const intent = appservice.getIntentForUserId(userId);
			await ensureEncryption(intent);
			await onEncryptionReady(intent, owner);
		} catch (err: unknown) {
			log.warn({ userId, err }, 'encryption setup failed at start');
		}
	}
	// The creator reads and writes encrypted rooms too, as Twake Chat opens its direct messages
	// encrypted. Its setup comes before the first push, as the assistants' do: a setup a push starts
	// and that fails leaves the push unanswered in the SDK.
	await ensureEncryption(appservice.botIntent);
	await appservice.begin();
	// The SDK serves Synapse's pushes on its own HTTP server, and its stop only closes the listening
	// socket: Synapse keeps its connection alive and goes on pushing on it, and the SDK goes on
	// processing those pushes, its storage queries included, after the role has stopped. Its request
	// listeners are wrapped here. Once the role stops, a push is refused, and Synapse pushes it again
	// later; the pushes already accepted are counted, so that the stop waits for them.
	let closing = false;
	let pushesInFlight = 0;
	const server: unknown = Reflect.get(appservice, 'appServer');
	const appServer = server instanceof Server ? server : null;
	if (appServer !== null) {
		const sdkListeners = appServer.listeners('request');
		appServer.removeAllListeners('request');
		appServer.on('request', (request: IncomingMessage, response: ServerResponse) => {
			if (closing) {
				response.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
				response.end(
					JSON.stringify({ errcode: 'M_UNKNOWN', error: 'the matrix role is stopping' })
				);
				return;
			}
			pushesInFlight += 1;
			response.on('close', () => {
				pushesInFlight -= 1;
			});
			for (const listener of sdkListeners) Reflect.apply(listener, appServer, [request, response]);
		});
	} else {
		log.warn('appservice HTTP server not found: a stop will not wait for the pushes under way');
	}
	// Waits for the pushes and the listeners under way, a push being able to start more listeners. It
	// polls on a timer, so that the work it waits for keeps the event loop to itself; a push the SDK
	// fails to finish never answers, so the wait is bounded.
	async function drain(): Promise<void> {
		const deadline = Date.now() + STOP_DRAIN_MS;
		while (pushesInFlight > 0 || inFlight.size > 0) {
			if (Date.now() >= deadline) {
				log.warn(
					{ pushesInFlight, listeners: inFlight.size },
					'matrix role stopped with work under way'
				);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	log.info({ port: options.port, creator, homeserverUrl }, 'matrix role listening');
	let stopping: Promise<void> | null = null;
	return {
		appservice,
		creatorUserId: creator,
		assistants,
		stop: (): Promise<void> => {
			stopping ??= (async () => {
				// What Synapse pushes from now on is refused; what it already pushed finishes, listeners
				// included, then the sends and the feedback. The server closes last: until then the
				// work above may still need it.
				closing = true;
				await drain();
				await sender.stop();
				await feedback.stop();
				appservice.stop();
				appServer?.closeAllConnections();
				rejections.uninstall();
			})();
			return stopping;
		}
	};
}

function ensureTrailingSlash(url: URL): URL {
	return url.pathname.endsWith('/') ? url : new URL(`${url.href}/`);
}
