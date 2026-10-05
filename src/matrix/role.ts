import {
	Appservice,
	getRequestFn,
	LogService,
	setRequestFn,
	type MatrixEvent
} from 'matrix-bot-sdk';
import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { helpText, parseCreatorCommand } from './creator.js';
import { buildRegistration, creatorUserId, isAssistantUserId } from './registration.js';
import { makeAppserviceStorage } from './storage.js';

export interface MatrixRoleOptions {
	readonly config: Config;
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	readonly port: number;
	readonly bindAddress?: string;
}

export interface MatrixRole {
	readonly appservice: Appservice;
	readonly creatorUserId: string;
	stop(): Promise<void>;
}

interface RoomEvent {
	readonly type?: string;
	readonly sender?: string;
	readonly state_key?: string;
	readonly content?: Record<string, unknown>;
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

	appservice.on('room.message', async (roomId: string, event: MatrixEvent<unknown> | RoomEvent) => {
		const raw = event as RoomEvent;
		const sender = raw.sender ?? '';
		if (sender === creator || isAssistantUserId(config, sender)) return;
		const text = textOf(raw);
		if (text === null) return;
		if (!(await creatorIsInRoom(roomId))) return;
		const command = parseCreatorCommand(text);
		log.info({ roomId, sender, command: command.kind }, 'creator command');
		const reply =
			command.kind === 'help'
				? helpText()
				: `I did not understand « ${command.text} ». Send /help for the commands.`;
		await appservice.botIntent.sendText(roomId, reply);
	});

	await appservice.begin();
	log.info({ port: options.port, creator, homeserverUrl }, 'matrix role listening');
	return {
		appservice,
		creatorUserId: creator,
		stop: async () => {
			appservice.stop();
		}
	};
}

function ensureTrailingSlash(url: URL): URL {
	return url.pathname.endsWith('/') ? url : new URL(`${url.href}/`);
}
