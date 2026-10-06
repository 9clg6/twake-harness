import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

// The Synapse of the platform; CI also runs the suites against the latest release
const IMAGE = process.env['SYNAPSE_IMAGE'] ?? 'ghcr.io/element-hq/synapse:v1.160.0';
export const SYNAPSE_SERVER_NAME = 'test.local';
const SHARED_SECRET = 'test-registration-secret';

export interface AppserviceRegistration {
	// The registration file Synapse loads, as the harness builds it
	readonly file: Record<string, unknown>;
}

export interface MatrixUser {
	readonly userId: string;
	readonly accessToken: string;
}

export interface MatrixReply {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

export interface TestSynapse {
	readonly url: string;
	registerUser(localpart: string): Promise<MatrixUser>;
	request(
		user: MatrixUser | null,
		method: string,
		path: string,
		body?: unknown
	): Promise<MatrixReply>;
	createDirectRoom(user: MatrixUser, invite: string): Promise<string>;
	sendText(user: MatrixUser, roomId: string, text: string): Promise<string>;
	messagesFrom(user: MatrixUser, roomId: string, sender: string): Promise<string[]>;
	waitForMessage(
		user: MatrixUser,
		roomId: string,
		sender: string,
		predicate: (text: string) => boolean
	): Promise<string>;
	pendingInvites(user: MatrixUser): Promise<{ roomId: string; inviter: string }[]>;
	joinRoom(user: MatrixUser, roomId: string): Promise<void>;
	joinedMembers(user: MatrixUser, roomId: string): Promise<string[]>;
	displayName(userId: string): Promise<string | null>;
	whoami(accessToken: string): Promise<number>;
	logs(): Promise<string>;
	stop(): Promise<void>;
}

export interface ReservedPort {
	readonly port: number;
	// Lets the port go, right before whoever reserved it listens on it
	release(): Promise<void>;
}

// A port held until it is needed: Docker maps the containers' ports on the host in the same
// range, so a port merely found free could be taken while a container starts.
export async function reservePort(): Promise<ReservedPort> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, '0.0.0.0', () => {
			const address = server.address();
			if (address === null || typeof address === 'string') {
				reject(new Error('no port'));
				return;
			}
			resolve({
				port: address.port,
				release: () => new Promise((done) => server.close(() => done()))
			});
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const GENEROUS = { per_second: 1000, burst_count: 1000 };

// A real Synapse, configured with the harness registration, that pushes to this host.
// The containers run as the host user, so the files they write in the shared directory stay
// readable on Linux hosts, where a bind mount keeps the container's ownership.
function hostIdentity(): { UID: string; GID: string } {
	return {
		UID: String(process.getuid?.() ?? 1000),
		GID: String(process.getgid?.() ?? 1000)
	};
}

export async function startTestSynapse(registration: AppserviceRegistration): Promise<TestSynapse> {
	const dir = await mkdtemp(join(tmpdir(), 'synapse-'));
	await new GenericContainer(IMAGE)
		.withEnvironment({ SYNAPSE_SERVER_NAME, SYNAPSE_REPORT_STATS: 'no', ...hostIdentity() })
		.withBindMounts([{ source: dir, target: '/data' }])
		.withCommand(['generate'])
		.withWaitStrategy(Wait.forOneShotStartup())
		.start();
	const configPath = join(dir, 'homeserver.yaml');
	const config = load(await readFile(configPath, 'utf8')) as Record<string, unknown>;
	Object.assign(config, {
		enable_registration: true,
		enable_registration_without_verification: true,
		registration_shared_secret: SHARED_SECRET,
		app_service_config_files: ['/data/harness.yaml'],
		experimental_features: {
			msc2409_to_device_messages_enabled: true,
			msc3202_device_masquerading: true,
			msc3202_transaction_extensions: true
		},
		rc_message: GENEROUS,
		rc_registration: GENEROUS,
		rc_login: { address: GENEROUS, account: GENEROUS, failed_attempts: GENEROUS },
		rc_joins: { local: GENEROUS, remote: GENEROUS },
		rc_invites: { per_room: GENEROUS, per_user: GENEROUS, per_issuer: GENEROUS }
	});
	await writeFile(configPath, dump(config));
	await writeFile(join(dir, 'harness.yaml'), dump(registration.file));
	const container: StartedTestContainer = await new GenericContainer(IMAGE)
		.withEnvironment(hostIdentity())
		.withBindMounts([{ source: dir, target: '/data' }])
		.withExposedPorts(8008)
		.withExtraHosts([{ host: 'host.docker.internal', ipAddress: 'host-gateway' }])
		.withWaitStrategy(Wait.forHttp('/_matrix/client/versions', 8008))
		.start();
	const url = `http://${container.getHost()}:${container.getMappedPort(8008)}`;

	async function request(
		user: MatrixUser | null,
		method: string,
		path: string,
		body?: unknown
	): Promise<MatrixReply> {
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (user !== null) headers['authorization'] = `Bearer ${user.accessToken}`;
		const res = await fetch(`${url}${path}`, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		});
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	async function registerUser(localpart: string): Promise<MatrixUser> {
		const nonce = (await request(null, 'GET', '/_synapse/admin/v1/register')).body[
			'nonce'
		] as string;
		const password = `${localpart}-password`;
		const mac = createHmac('sha1', SHARED_SECRET)
			.update(`${nonce}\0${localpart}\0${password}\0notadmin`)
			.digest('hex');
		const res = await request(null, 'POST', '/_synapse/admin/v1/register', {
			nonce,
			username: localpart,
			password,
			admin: false,
			mac
		});
		if (res.status !== 200) {
			throw new Error(`registration of ${localpart} failed: ${JSON.stringify(res.body)}`);
		}
		return {
			userId: res.body['user_id'] as string,
			accessToken: res.body['access_token'] as string
		};
	}

	async function createDirectRoom(user: MatrixUser, invite: string): Promise<string> {
		const res = await request(user, 'POST', '/_matrix/client/v3/createRoom', {
			is_direct: true,
			preset: 'trusted_private_chat',
			invite: [invite]
		});
		if (res.status !== 200) throw new Error(`createRoom failed: ${JSON.stringify(res.body)}`);
		return res.body['room_id'] as string;
	}

	async function sendText(user: MatrixUser, roomId: string, text: string): Promise<string> {
		const txn = `${Date.now()}-${Math.random()}`;
		const res = await request(
			user,
			'PUT',
			`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
			{ msgtype: 'm.text', body: text }
		);
		if (res.status !== 200) throw new Error(`send failed: ${JSON.stringify(res.body)}`);
		return res.body['event_id'] as string;
	}

	interface TimelineEvent {
		type: string;
		sender: string;
		content: { body?: string };
	}

	async function messagesFrom(user: MatrixUser, roomId: string, sender: string): Promise<string[]> {
		const res = await request(
			user,
			'GET',
			`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50`
		);
		const chunk = (res.body['chunk'] ?? []) as TimelineEvent[];
		return chunk
			.filter(
				(e) =>
					e.type === 'm.room.message' && e.sender === sender && typeof e.content.body === 'string'
			)
			.map((e) => e.content.body ?? '')
			.reverse();
	}

	async function waitForMessage(
		user: MatrixUser,
		roomId: string,
		sender: string,
		predicate: (text: string) => boolean
	): Promise<string> {
		for (let i = 0; i < 60; i += 1) {
			const found = (await messagesFrom(user, roomId, sender)).find(predicate);
			if (found !== undefined) return found;
			await sleep(250);
		}
		throw new Error(`no message from ${sender} in ${roomId} matched within 15 s`);
	}

	async function pendingInvites(user: MatrixUser): Promise<{ roomId: string; inviter: string }[]> {
		const res = await request(user, 'GET', '/_matrix/client/v3/sync?timeout=0');
		const invites = ((res.body['rooms'] as Record<string, unknown> | undefined)?.['invite'] ??
			{}) as Record<
			string,
			{ invite_state?: { events?: { type: string; sender: string; state_key?: string }[] } }
		>;
		return Object.entries(invites).map(([roomId, room]) => {
			const member = (room.invite_state?.events ?? []).find(
				(e) => e.type === 'm.room.member' && e.state_key === user.userId
			);
			return { roomId, inviter: member?.sender ?? '' };
		});
	}

	async function joinRoom(user: MatrixUser, roomId: string): Promise<void> {
		const res = await request(
			user,
			'POST',
			`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
			{}
		);
		if (res.status !== 200) throw new Error(`join failed: ${JSON.stringify(res.body)}`);
	}

	async function joinedMembers(user: MatrixUser, roomId: string): Promise<string[]> {
		const res = await request(
			user,
			'GET',
			`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`
		);
		return Object.keys((res.body['joined'] as Record<string, unknown> | undefined) ?? {});
	}

	async function displayName(userId: string): Promise<string | null> {
		const res = await request(
			null,
			'GET',
			`/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`
		);
		const name = res.body['displayname'];
		return typeof name === 'string' ? name : null;
	}

	async function whoami(accessToken: string): Promise<number> {
		return (await request({ userId: '', accessToken }, 'GET', '/_matrix/client/v3/account/whoami'))
			.status;
	}

	return {
		url,
		registerUser,
		request,
		createDirectRoom,
		sendText,
		messagesFrom,
		waitForMessage,
		pendingInvites,
		joinRoom,
		joinedMembers,
		displayName,
		whoami,
		logs: async () => {
			// The log stream follows the container and never ends: read what is there, then let go
			const stream = await container.logs();
			const chunks: string[] = [];
			await new Promise<void>((resolve) => {
				const done = (): void => {
					clearTimeout(timer);
					stream.destroy();
					resolve();
				};
				const timer = setTimeout(done, 1500);
				stream.on('data', (chunk: Buffer | string) => {
					chunks.push(String(chunk));
				});
				stream.on('end', done);
				stream.on('error', done);
			});
			return chunks.join('');
		},
		stop: async () => {
			await container.stop();
		}
	};
}
