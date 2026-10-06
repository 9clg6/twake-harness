import { mkdirSync } from 'node:fs';
import {
	EncryptedRoomEvent,
	type Intent,
	Appservice,
	getRequestFn,
	LogService,
	RustSdkAppserviceCryptoStorageProvider,
	setRequestFn,
	type MatrixEvent
} from 'matrix-bot-sdk';
import { StoreType } from '@matrix-org/matrix-sdk-crypto-nodejs';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

import {
	findAssistant,
	findDialog,
	listActiveAssistants,
	saveDialog
} from '../assistants/repository.js';
import { enqueueJob } from '../jobs/queue.js';
import { startJobWorker, type JobWorker } from '../jobs/worker.js';
import { makeAssistantService, type AssistantService } from '../assistants/service.js';
import type { Config } from '../config.js';
import { withPrincipal, type Db } from '../db/client.js';
import { ORGANIZATION_PRINCIPAL } from '../principals/principal.js';
import { matrixUserIdOfPrincipal, principalOfMatrixUser } from '../principals/identity.js';
import { makeMatrixAdmin } from './admin.js';
import { makeOpenBaoEscrow } from '../escrow/openbao.js';
import { backupRoomKeys, ensureEscrow, recoverFromEscrow, type EscrowDeps } from './escrow.js';
import {
	ensureCrossSigning,
	type CrossSigningDeps,
	type CrossSigningResult
} from './cross-signing.js';
import { helpText, runCreatorTurn } from './creator.js';
import { buildRegistration, creatorUserId, isAssistantUserId } from './registration.js';
import { makeChatFeedback, type TurnOutcome, type TurnRef } from './feedback.js';
import { makeRichText } from './format.js';
import { ensureOrgAgent, isOrgMember, orgAgentUserId, orgGreeting } from './org.js';
import { makeAppserviceStorage } from './storage.js';

export interface MatrixRoleOptions {
	readonly config: Config;
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	readonly port: number;
	readonly bindAddress?: string;
	readonly pollIntervalMs?: number;
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

interface SendJob {
	readonly asUserId: string;
	readonly roomId: string;
	readonly text: string;
	// The owner's message the text answers, for the reactions on it
	readonly replyTo?: string;
	readonly outcome?: TurnOutcome;
}

const RECOVERED_TEXT =
	'My identity is back from the escrow. Messages encrypted for my lost device stay unreadable until their keys are restored; everything from now on is fine.';
const NO_ESCROW_TEXT = 'I found no escrow to recover from; my identity is new from here on.';
const recoverPayload = z.object({ owner: z.string().min(1) });

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
		(job['outcome'] === undefined || job['outcome'] === 'answered' || job['outcome'] === 'failed')
	);
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

export async function startMatrixRole(options: MatrixRoleOptions): Promise<MatrixRole> {
	const { config, db, log } = options;
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
	const appservice = new Appservice({
		port: options.port,
		bindAddress: options.bindAddress ?? '0.0.0.0',
		homeserverName: config.matrix.serverName,
		homeserverUrl,
		// The url only matters to Synapse, which reads it from its own registration file
		registration: buildRegistration(config, ''),
		storage,
		// One encryption store per assistant, on the volume of this role
		cryptoStorage: new RustSdkAppserviceCryptoStorageProvider(
			config.matrix.cryptoStorePath,
			StoreType.Sqlite
		)
	});
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
	async function onEncryptionReady(intent: Intent, owner: string): Promise<void> {
		log.info(
			{ owner, userId: intent.userId, deviceId: intent.underlyingClient.crypto?.clientDeviceId },
			'encryption ready'
		);
		let signed: CrossSigningResult;
		try {
			signed = await ensureCrossSigning(crossSigning, intent, owner);
		} catch (err: unknown) {
			log.error({ owner, userId: intent.userId, err }, 'cross-signing failed');
			return;
		}
		if (escrow === null || signed.outcome === 'awaiting_recovery') return;
		if (signed.masterPublicKey === null) return;
		try {
			await ensureEscrow(escrow, intent, owner, signed.masterPublicKey);
		} catch (err: unknown) {
			log.error({ owner, userId: intent.userId, err }, 'escrow failed');
		}
	}
	function backupInBackground(userId: string, owner: string): void {
		if (escrow === null) return;
		backupRoomKeys(escrow, appservice.getIntentForUserId(userId), owner).catch((err: unknown) => {
			log.warn({ owner, userId, err }, 'room keys backup failed');
		});
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
		await intent.enableEncryption();
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
	appservice.on('device_lists', async (lists: { changed?: string[]; removed?: string[] }) => {
		const changed = lists.changed ?? [];
		const removed = lists.removed ?? [];
		if (changed.length === 0 && removed.length === 0) return;
		for (const { userId } of await listActiveAssistants(db)) {
			try {
				const intent = appservice.getIntentForUserId(userId);
				await intent.enableEncryption();
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
	});

	appservice.on(
		'room.failed_decryption',
		async (roomId: string, event: RoomEvent, err: unknown) => {
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
					// What the SDK hands here is the raw event itself
					new EncryptedRoomEvent(event as unknown as Record<string, unknown>),
					roomId
				);
				if (decrypted.type === 'm.room.message') await onRoomMessage(roomId, decrypted);
			} catch (retryErr: unknown) {
				log.warn({ roomId, eventId: event.event_id, err: retryErr }, 'decryption retry failed');
			}
		}
	);

	appservice.on('room.invite', async (roomId: string, event: RoomEvent) => {
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
				await intent.enableEncryption();
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
		log.info({ roomId, invited, sender: event.sender }, 'invite accepted');
		try {
			const intent = appservice.getIntentForUserId(invited);
			// Key shares for this room may arrive with the next transaction: be ready to receive them
			await intent.enableEncryption();
			await intent.joinRoom(roomId);
		} catch (err: unknown) {
			log.warn({ roomId, invited, err }, 'join failed');
			return;
		}
		// Synapse delivers nothing sent before the join, so the creator opens the conversation
		// itself rather than let a first message go unanswered.
		if (invited === creator) await appservice.botIntent.sendEvent(roomId, makeRichText(helpText()));
	});

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

	// The owner has joined: their devices are in the room, the greeting can be encrypted for them
	appservice.on('room.event', async (roomId: string, event: RoomEvent) => {
		if (event.type !== 'm.room.member' || event.content?.['membership'] !== 'join') return;
		const room = await assistantRoom(roomId);
		if (room === null || room.welcome === null) return;
		if (event.state_key !== matrixUserIdOfPrincipal(config, room.owner)) return;
		const claimed = await db.sql`
			update assistant_rooms set welcome = null where room_id = ${roomId} and welcome is not null`;
		if (claimed.count !== 1) return;
		await enqueueJob(db, {
			kind: 'send',
			payload: { asUserId: room.userId, roomId, text: room.welcome },
			dedupKey: `welcome:${roomId}`
		});
		log.info({ roomId, owner: room.owner }, 'welcome queued');
	});

	// Eyes and typing while a turn works, a check mark once it answered
	const feedback = makeChatFeedback({
		log,
		setTyping: async (userId, roomId, typing, timeoutMs) => {
			await appservice
				.getIntentForUserId(userId)
				.underlyingClient.setTyping(roomId, typing, timeoutMs);
		},
		sendEvent: async (userId, roomId, type, content) => {
			const intent = appservice.getIntentForUserId(userId);
			await intent.enableEncryption();
			await refreshMembersDevices(intent, roomId);
			return intent.underlyingClient.sendEvent(roomId, type, content);
		},
		redactEvent: async (userId, roomId, eventId) => {
			await appservice.getIntentForUserId(userId).underlyingClient.redactEvent(roomId, eventId);
		}
	});

	appservice.on('room.message', onRoomMessage);

	async function onRoomMessage(
		roomId: string,
		event: MatrixEvent<unknown> | RoomEvent
	): Promise<void> {
		const raw = event as RoomEvent;
		const sender = raw.sender ?? '';
		log.info({ roomId, sender, eventId: raw.event_id }, 'message received');
		if (sender === creator || isAssistantUserId(config, sender)) return;
		const text = textOf(raw);
		if (text === null) return;
		const room = await assistantRoom(roomId);
		if (room !== null) {
			let owner: string;
			let message = text;
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
			}
			const eventId = raw.event_id ?? `${roomId}:${Date.now()}`;
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
		const state = await withPrincipal(db, { id: owner }, (tx) => findDialog(tx, owner));
		const turn = await runCreatorTurn({ owner, text, state }, assistants);
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
		await intent.enableEncryption();
		const result = await recoverFromEscrow(escrow, intent, owner);
		log.info({ owner, userId: assistant.userId, result }, 'recovery done');
		if (assistant.roomId === null) return;
		await enqueueJob(db, {
			kind: 'send',
			payload: {
				asUserId: assistant.userId,
				roomId: assistant.roomId,
				text: result === 'recovered' ? RECOVERED_TEXT : NO_ESCROW_TEXT
			},
			dedupKey: `recover-notice:${owner}:${Date.now()}`,
			groupKey: `send:${assistant.roomId}`
		});
	}

	const sender: JobWorker = startJobWorker({
		db,
		log,
		kinds: ['send', 'recover'],
		...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
		handler: async (job) => {
			if (job.kind === 'recover') {
				const parsed = recoverPayload.safeParse(job.payload);
				if (!parsed.success) throw new Error('recover payload is malformed');
				await recover(parsed.data.owner);
				return;
			}
			if (!isSendJob(job.payload)) throw new Error('send payload is malformed');
			const intent = appservice.getIntentForUserId(job.payload.asUserId);
			await intent.enableEncryption();
			const room = await assistantRoom(job.payload.roomId);
			if (room !== null) await onEncryptionReady(intent, room.owner);
			await refreshMembersDevices(intent, job.payload.roomId);
			const turn = turnOf(job.payload);
			if (turn !== null) await feedback.answerReady(turn);
			await intent.sendEvent(job.payload.roomId, makeRichText(job.payload.text));
			log.info({ roomId: job.payload.roomId, asUserId: job.payload.asUserId }, 'answer sent');
			if (turn !== null) {
				feedback
					.answerSent(turn, job.payload.outcome ?? 'answered')
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
	for (const { owner, userId } of await listActiveAssistants(db)) {
		try {
			const intent = appservice.getIntentForUserId(userId);
			await intent.enableEncryption();
			await onEncryptionReady(intent, owner);
		} catch (err: unknown) {
			log.warn({ userId, err }, 'encryption setup failed at start');
		}
	}
	await appservice.begin();
	// The creator reads and writes encrypted rooms too, as Twake Chat opens its direct messages encrypted
	await appservice.botIntent.enableEncryption();
	log.info({ port: options.port, creator, homeserverUrl }, 'matrix role listening');
	return {
		appservice,
		creatorUserId: creator,
		assistants,
		stop: async () => {
			await sender.stop();
			await feedback.stop();
			appservice.stop();
		}
	};
}

function ensureTrailingSlash(url: URL): URL {
	return url.pathname.endsWith('/') ? url : new URL(`${url.href}/`);
}
