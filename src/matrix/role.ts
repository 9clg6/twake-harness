import { mkdirSync } from 'node:fs';
import {
	Appservice,
	getRequestFn,
	LogService,
	RustSdkAppserviceCryptoStorageProvider,
	setRequestFn,
	type MatrixEvent
} from 'matrix-bot-sdk';
import { StoreType } from '@matrix-org/matrix-sdk-crypto-nodejs';
import type { FastifyBaseLogger } from 'fastify';

import { findDialog, listActiveAssistantUserIds, saveDialog } from '../assistants/repository.js';
import { enqueueJob } from '../jobs/queue.js';
import { startJobWorker, type JobWorker } from '../jobs/worker.js';
import {
	makeAssistantService,
	ownerMatrixId,
	type AssistantService
} from '../assistants/service.js';
import type { Config } from '../config.js';
import { withPrincipal, type Db } from '../db/client.js';
import { makeMatrixAdmin } from './admin.js';
import { helpText, runCreatorTurn } from './creator.js';
import { buildRegistration, creatorUserId, isAssistantUserId } from './registration.js';
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
}

function isSendJob(value: unknown): value is SendJob {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as SendJob).asUserId === 'string' &&
		typeof (value as SendJob).roomId === 'string' &&
		typeof (value as SendJob).text === 'string'
	);
}

function textOf(event: RoomEvent): string | null {
	const content = event.content ?? {};
	return content['msgtype'] === 'm.text' && typeof content['body'] === 'string'
		? content['body']
		: null;
}

const LOCALPART = /^[a-z0-9._=\-/+]+$/;

// The owner of a conversation is the localpart of a user of our own homeserver, which is also
// their principal identity everywhere else in the harness.
export function principalOfSender(config: Config, sender: string): string | null {
	const match = /^@([^:]+):(.+)$/.exec(sender);
	if (match === null) return null;
	const [, localpart, server] = match;
	if (
		localpart === undefined ||
		server !== config.matrix.serverName ||
		!LOCALPART.test(localpart)
	) {
		return null;
	}
	return localpart;
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
	const appservice = new Appservice({
		port: options.port,
		bindAddress: options.bindAddress ?? '0.0.0.0',
		homeserverName: config.matrix.serverName,
		homeserverUrl,
		// The url only matters to Synapse, which reads it from its own registration file
		registration: buildRegistration(config, ''),
		storage: makeAppserviceStorage(db),
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

	appservice.on('room.failed_decryption', (roomId: string, event: RoomEvent, err: unknown) => {
		log.error({ roomId, sender: event.sender, eventId: event.event_id, err }, 'decryption failed');
	});

	appservice.on('room.invite', async (roomId: string, event: RoomEvent) => {
		const invited = event.state_key ?? '';
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
		if (invited === creator) await appservice.botIntent.sendText(roomId, helpText());
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
		if (event.state_key !== ownerMatrixId(config, room.owner)) return;
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

	appservice.on('room.message', async (roomId: string, event: MatrixEvent<unknown> | RoomEvent) => {
		const raw = event as RoomEvent;
		const sender = raw.sender ?? '';
		log.info({ roomId, sender, eventId: raw.event_id }, 'message received');
		if (sender === creator || isAssistantUserId(config, sender)) return;
		const text = textOf(raw);
		if (text === null) return;
		const room = await assistantRoom(roomId);
		if (room !== null) {
			// An assistant's room: only its owner is heard, everyone else is ignored and logged
			const owner = principalOfSender(config, sender);
			if (owner === null || owner !== room.owner) {
				log.info({ roomId, sender, owner: room.owner }, 'assistant ignored a foreign sender');
				return;
			}
			const eventId = raw.event_id ?? `${roomId}:${Date.now()}`;
			// The turns of one owner run one after the other, in the order they were sent
			await enqueueJob(db, {
				kind: 'turn',
				payload: { owner, roomId, eventId, text },
				dedupKey: `turn:${eventId}`,
				groupKey: `turn:${owner}`
			});
			log.info({ roomId, owner, eventId }, 'turn queued');
			return;
		}
		if (!(await creatorIsInRoom(roomId))) return;
		const owner = principalOfSender(config, sender);
		if (owner === null) {
			log.info({ roomId, sender }, 'creator ignored a foreign sender');
			return;
		}
		const state = await withPrincipal(db, { id: owner }, (tx) => findDialog(tx, owner));
		const turn = await runCreatorTurn({ owner, text, state }, assistants);
		await withPrincipal(db, { id: owner }, (tx) => saveDialog(tx, owner, turn.nextState));
		log.info({ roomId, sender, owner, command: turn.command }, 'creator command');
		await appservice.botIntent.sendText(roomId, turn.reply);
	});

	// Answers computed by the api role, sent as the assistant through its intent, which encrypts
	// them when the room is encrypted
	const sender: JobWorker = startJobWorker({
		db,
		log,
		kinds: ['send'],
		...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
		handler: async (job) => {
			if (!isSendJob(job.payload)) throw new Error('send payload is malformed');
			const intent = appservice.getIntentForUserId(job.payload.asUserId);
			await intent.enableEncryption();
			await intent.sendText(job.payload.roomId, job.payload.text);
			log.info({ roomId: job.payload.roomId, asUserId: job.payload.asUserId }, 'answer sent');
		}
	});

	// Every assistant holds its encryption state from the start, so the key shares Synapse pushes
	// while this role was away, or before an assistant speaks, are not lost
	for (const userId of await listActiveAssistantUserIds(db)) {
		try {
			await appservice.getIntentForUserId(userId).enableEncryption();
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
			appservice.stop();
		}
	};
}

function ensureTrailingSlash(url: URL): URL {
	return url.pathname.endsWith('/') ? url : new URL(`${url.href}/`);
}
