import { randomUUID } from 'node:crypto';

// The calls the harness makes to Synapse as the application service, through the matrix route
// of APISIX: register and log in the assistants, open their rooms, speak for them.
export interface MatrixAdmin {
	registerUser(localpart: string): Promise<void>;
	loginDevice(localpart: string, deviceId: string): Promise<string>;
	setDisplayName(userId: string, name: string): Promise<boolean>;
	createDirectRoom(asUserId: string, inviteUserId: string): Promise<string>;
	sendText(asUserId: string, roomId: string, text: string): Promise<void>;
	leaveRoom(asUserId: string, roomId: string): Promise<void>;
	logoutDevice(accessToken: string): Promise<void>;
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
		async loginDevice(localpart, deviceId) {
			const response = await call(
				'POST',
				'/login',
				{
					type: 'm.login.application_service',
					identifier: { type: 'm.id.user', user: localpart },
					device_id: deviceId
				},
				options.asToken
			);
			const token = response.body['access_token'];
			if (response.status !== 200 || typeof token !== 'string') fail('login', response);
			return token;
		},
		async setDisplayName(userId, name) {
			const response = await call(
				'PUT',
				`/profile/${encodeURIComponent(userId)}/displayname`,
				{ displayname: name },
				options.asToken,
				userId
			);
			// Some homeservers refuse display name changes; the name then lives in the harness only
			return response.status === 200;
		},
		async createDirectRoom(asUserId, inviteUserId) {
			const response = await call(
				'POST',
				'/createRoom',
				{ is_direct: true, preset: 'trusted_private_chat', invite: [inviteUserId] },
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
		async logoutDevice(accessToken) {
			const response = await call('POST', '/logout', {}, accessToken);
			if (response.status !== 200 && response.status !== 401) fail('logout', response);
		}
	};
}
