import { randomUUID } from 'node:crypto';

// The calls the harness makes to Synapse as the application service, through the matrix route
// of APISIX: register and log in the assistants, open their rooms, speak for them.
export interface MatrixAdmin {
	registerUser(localpart: string): Promise<void>;
	setDisplayName(userId: string, name: string): Promise<boolean>;
	// The display name of a user of the homeserver; null when they have none, or no profile at all
	displayName(userId: string): Promise<string | null>;
	createDirectRoom(asUserId: string, inviteUserId: string): Promise<string>;
	sendText(asUserId: string, roomId: string, text: string): Promise<void>;
	leaveRoom(asUserId: string, roomId: string): Promise<void>;
	// The members joined to a room, as the user named reads them; null when that user is not in it
	joinedMembers(asUserId: string, roomId: string): Promise<string[] | null>;
	// A state event of a room as the user named reads it, its content; null when the room has none
	readState(asUserId: string, roomId: string, type: string, stateKey: string): Promise<unknown>;
	writeState(
		asUserId: string,
		roomId: string,
		type: string,
		stateKey: string,
		content: unknown
	): Promise<void>;
	// The cross-signing keys of an assistant, uploaded as the application service, which may
	// replace an identity the user already has: the device's own token would need interactive
	// authentication, which a user without a password cannot give
	uploadSigningKeys(asUserId: string, keys: unknown): Promise<void>;
}

export interface MatrixAdminOptions {
	readonly apisixBaseUrl: URL;
	readonly consumerKey: string;
	readonly asToken: string;
	readonly fetchImpl?: typeof fetch;
}

export class MatrixError extends Error {
	override readonly name = 'MatrixError';
	constructor(
		message: string,
		readonly status: number,
		readonly errcode: string | null
	) {
		super(message);
	}
}

function parseBody(text: string): unknown {
	if (text.length === 0) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return { raw: text };
	}
}

interface MatrixResponse {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

export function makeMatrixAdmin(options: MatrixAdminOptions): MatrixAdmin {
	const fetchImpl = options.fetchImpl ?? fetch;
	const base = options.apisixBaseUrl.href.endsWith('/')
		? options.apisixBaseUrl.href
		: `${options.apisixBaseUrl.href}/`;

	async function call(
		method: string,
		path: string,
		body: unknown,
		token: string,
		asUserId?: string
	): Promise<MatrixResponse> {
		const url = new URL(`matrix/_matrix/client/v3${path}`, base);
		if (asUserId !== undefined) url.searchParams.set('user_id', asUserId);
		const response = await fetchImpl(url, {
			method,
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
				apikey: options.consumerKey
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		});
		const text = await response.text();
		const parsed = parseBody(text);
		return {
			status: response.status,
			body: typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
		};
	}

	function fail(what: string, response: MatrixResponse): never {
		const errcode = typeof response.body['errcode'] === 'string' ? response.body['errcode'] : null;
		throw new MatrixError(
			`${what}: HTTP ${response.status} ${errcode ?? ''}`.trim(),
			response.status,
			errcode
		);
	}

	return {
		async registerUser(localpart) {
			const response = await call(
				'POST',
				'/register',
				{ type: 'm.login.application_service', username: localpart, inhibit_login: true },
				options.asToken
			);
			if (response.status === 200) return;
			if (response.body['errcode'] === 'M_USER_IN_USE') return;
			fail('register', response);
		},
		async uploadSigningKeys(asUserId, keys) {
			const response = await call(
				'POST',
				'/keys/device_signing/upload',
				keys,
				options.asToken,
				asUserId
			);
			if (response.status !== 200) fail('upload of the cross-signing keys', response);
		},
		async setDisplayName(userId, name) {
			const response = await call(
				'PUT',
				`/profile/${encodeURIComponent(userId)}/displayname`,
				{ displayname: name },
				options.asToken,
				userId
			);
			// False when the homeserver refuses the change, as some do
			return response.status === 200;
		},
		async displayName(userId) {
			const response = await call(
				'GET',
				`/profile/${encodeURIComponent(userId)}/displayname`,
				undefined,
				options.asToken
			);
			if (response.status === 404) return null;
			if (response.status !== 200) fail('display name', response);
			const name = response.body['displayname'];
			return typeof name === 'string' && name.trim() !== '' ? name : null;
		},
		async createDirectRoom(asUserId, inviteUserId) {
			// Encrypted from the first event: the keys of the room are only ever shared with the
			// owner's devices and the assistant's
			const response = await call(
				'POST',
				'/createRoom',
				{
					is_direct: true,
					preset: 'trusted_private_chat',
					invite: [inviteUserId],
					initial_state: [
						{
							type: 'm.room.encryption',
							state_key: '',
							content: { algorithm: 'm.megolm.v1.aes-sha2' }
						}
					]
				},
				options.asToken,
				asUserId
			);
			const roomId = response.body['room_id'];
			if (response.status !== 200 || typeof roomId !== 'string') fail('createRoom', response);
			return roomId;
		},
		async sendText(asUserId, roomId, text) {
			const response = await call(
				'PUT',
				`/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${randomUUID()}`,
				{ msgtype: 'm.text', body: text },
				options.asToken,
				asUserId
			);
			if (response.status !== 200) fail('send', response);
		},
		async leaveRoom(asUserId, roomId) {
			const response = await call(
				'POST',
				`/rooms/${encodeURIComponent(roomId)}/leave`,
				{},
				options.asToken,
				asUserId
			);
			if (response.status !== 200 && response.status !== 403) fail('leave', response);
		},
		async joinedMembers(asUserId, roomId) {
			const response = await call(
				'GET',
				`/rooms/${encodeURIComponent(roomId)}/joined_members`,
				undefined,
				options.asToken,
				asUserId
			);
			if (response.status === 403 || response.status === 404) return null;
			if (response.status !== 200) fail('joined members', response);
			const joined = response.body['joined'];
			return typeof joined === 'object' && joined !== null ? Object.keys(joined) : [];
		},
		async readState(asUserId, roomId, type, stateKey) {
			const response = await call(
				'GET',
				`/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
				undefined,
				options.asToken,
				asUserId
			);
			if (response.status === 404) return null;
			if (response.status !== 200) fail('read of a state event', response);
			return response.body;
		},
		async writeState(asUserId, roomId, type, stateKey, content) {
			const response = await call(
				'PUT',
				`/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
				content,
				options.asToken,
				asUserId
			);
			if (response.status !== 200) fail('write of a state event', response);
		}
	};
}
