import {
	Appservice,
	getRequestFn,
	LogService,
	setRequestFn,
	type MatrixEvent
} from 'matrix-bot-sdk';
import type { FastifyBaseLogger } from 'fastify';

import { findDialog, saveDialog } from '../assistants/repository.js';
import { enqueueJob } from '../jobs/queue.js';
import { startJobWorker, type JobWorker } from '../jobs/worker.js';
import { makeAssistantService, type AssistantService } from '../assistants/service.js';
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
		info: (module: string, ...rest: unknown[]) => log.debug({ module, rest }, 'matrix sdk'),
		warn: (module: string, ...rest: unknown[]) => log.warn({ module, rest }, 'matrix sdk'),
		error: (module: string, ...rest: unknown[]) => log.error({ module, rest }, 'matrix sdk')
	});
	const homeserverUrl = new URL('matrix', ensureTrailingSlash(config.apisix.baseUrl)).href;
	// Every call of the SDK goes to APISIX, which admits the harness by its consumer key
	const originalRequest = getRequestFn();
	setRequestFn((params: { headers?: Record<string, string> }, callback: unknown) => {
		params.headers = { ...(params.headers ?? {}), apikey: config.apisix.consumerKey };
		return originalRequest(params, callback);
	});
	const appservice = new Appservice({
		port: options.port,
		bindAddress: options.bindAddress ?? '0.0.0.0',
		homeserverName: config.matrix.serverName,
		homeserverUrl,
		// The url only matters to Synapse, which reads it from its own registration file
		registration: buildRegistration(config, ''),
		storage: makeAppserviceStorage(db)
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

	appservice.on('room.invite', async (roomId: string, event: RoomEvent) => {
		const invited = event.state_key ?? '';
		if (invited !== creator && !isAssistantUserId(config, invited)) return;
		log.info({ roomId, invited, sender: event.sender }, 'invite accepted');
		try {
			await appservice.getIntentForUserId(invited).joinRoom(roomId);
		} catch (err: unknown) {
			log.warn({ roomId, invited, err }, 'join failed');
			return;
		}
		// Synapse delivers nothing sent before the join, so the creator opens the conversation
		// itself rather than let a first message go unanswered.
		if (invited === creator) await appservice.botIntent.sendText(roomId, helpText());
	});

	// The rooms of the assistants, kept as an index so a message is routed to its owner first
	async function assistantRoom(roomId: string): Promise<{ owner: string; userId: string } | null> {
		const rows = await db.sql<{ owner: string; user_id: string }[]>`
			select owner, user_id from assistant_rooms where room_id = ${roomId}`;
		const row = rows[0];
		return row === undefined ? null : { owner: row.owner, userId: row.user_id };
	}

	appservice.on('room.message', async (roomId: string, event: MatrixEvent<unknown> | RoomEvent) => {
		const raw = event as RoomEvent;
		const sender = raw.sender ?? '';
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
			await enqueueJob(db, {
				kind: 'turn',
				payload: { owner, roomId, eventId, text },
				dedupKey: `turn:${eventId}`
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

	// Answers computed by the api role, sent as the assistant
	const sender: JobWorker = startJobWorker({
		db,
		log,
		kinds: ['send'],
		...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
		handler: async (job) => {
			if (!isSendJob(job.payload)) throw new Error('send payload is malformed');
			await admin.sendText(job.payload.asUserId, job.payload.roomId, job.payload.text);
			log.info({ roomId: job.payload.roomId, asUserId: job.payload.asUserId }, 'answer sent');
		}
	});

	await appservice.begin();
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
