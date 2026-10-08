import { randomUUID } from 'node:crypto';

import type { FastifyBaseLogger } from 'fastify';
import { Intent, type Appservice, type MatrixClient, type UserDevice } from 'matrix-bot-sdk';

import { describeRejection } from './last-resort.js';

export interface EncryptionSetupDeps {
	readonly log: FastifyBaseLogger;
	// The device the encryption store of a user was made for, null for a store never used
	readonly storedDeviceId: (userId: string) => Promise<string | null>;
}

// Sets the encryption of an intent up, once per intent; a setup that failed is tried again on the
// next call. Every setup of the matrix role goes through it, the SDK's own included.
export type EnsureEncryption = (intent: Intent) => Promise<void>;

function hasIdentityKey(deviceId: string, device: UserDevice): boolean {
	return device.device_id === deviceId && device.keys?.[`curve25519:${deviceId}`] !== undefined;
}

// The SDK speaks for a user either as the application service naming one of the user's devices,
// or with the access token of a device it logs in. APISIX sets the application service token on
// every request it forwards to Synapse, so only the first way works: a logged-in device is spoken
// for as the application service all the same, whose whoami names no device, and the setup fails
// with "server not revealing device ID". The SDK takes the first way when the device of the store
// still exists, or else when the user has a device without keys. An assistant the harness just
// registered has no device at all: one is created here, by the login the SDK would make, its token
// dropped unread. The device is kept, as the SDK keeps those it logs in.
async function ensureDeviceToSpeakFor(deps: EncryptionSetupDeps, intent: Intent): Promise<void> {
	const userId = intent.userId;
	const client = intent.underlyingClient;
	// Registered first: a user the SDK registers itself, as the creator on its first start, gets a
	// device from its registration
	await intent.ensureRegistered();
	const devices = (await client.getOwnDevices()).map((device) => device.device_id);
	const stored = await deps.storedDeviceId(userId);
	if (stored !== null && devices.includes(stored)) return;
	const known = (await client.getUserDevices([userId])).device_keys[userId] ?? {};
	const withKeys = Object.entries(known)
		.filter(([deviceId, device]) => hasIdentityKey(deviceId, device))
		.map(([deviceId]) => deviceId);
	if (devices.some((deviceId) => !withKeys.includes(deviceId))) return;
	if (stored !== null) {
		// The store holds the keys of a device the homeserver no longer has: a new device would not
		// match them, so the store has to go first
		deps.log.warn({ userId, deviceId: stored }, 'encryption store of a deleted device');
		return;
	}
	const login: { device_id?: unknown } = await client.doRequest(
		'POST',
		'/_matrix/client/v3/login',
		null,
		{ type: 'm.login.application_service', identifier: { type: 'm.id.user', user: userId } }
	);
	const deviceId = typeof login.device_id === 'string' ? login.device_id : null;
	deps.log.info({ userId, deviceId }, 'encryption device created');
}

// matrix-bot-sdk 0.8 keeps the promise of an intent's first encryption setup in a private field and
// hands it to every later call, a rejected one included: one failure, as a homeserver hiccup, would
// leave the user unable to encrypt until the process restarts. Dropping it lets the next call set
// the encryption up again.
function forgetSdkSetup(intent: Intent): void {
	Reflect.deleteProperty(intent, 'cryptoSetupPromise');
}

// Synapse keys the transactions of an application service by their path and the service, never by
// the user the service speaks for, and the SDK names a to-device transaction by the millisecond and
// a counter of its own per user, which every start of the matrix role sets back to nothing. Two
// users of the service sending to devices in the same millisecond, as assistants sharing their room
// keys after a restart, could name the same transaction: Synapse took the second send for a repeat of
// the first and dropped it, a room key with it, which left every later answer unreadable on the
// devices it was for. Each to-device send names its transaction apart instead.
export function uniqueToDeviceTransactions(client: MatrixClient): void {
	// The SDK hands what the homeserver answers to the crypto engine, which marks the request sent
	client.sendToDevices = (type, messages) =>
		client.doRequest(
			'PUT',
			`/_matrix/client/v3/sendToDevice/${encodeURIComponent(type)}/${randomUUID()}`,
			null,
			{ messages }
		) as Promise<void>;
}

// The HTTP status of a failed request, which the SDK carries on what it throws
function statusOf(err: unknown): number | null {
	if (typeof err !== 'object' || err === null) return null;
	const status: unknown = Reflect.get(err, 'statusCode');
	return typeof status === 'number' ? status : null;
}

export function makeEnsureEncryption(deps: EncryptionSetupDeps): EnsureEncryption {
	const setups = new WeakMap<Intent, Promise<void>>();
	return (intent) => {
		const known = setups.get(intent);
		if (known !== undefined) return known;
		const setup = (async (): Promise<void> => {
			await ensureDeviceToSpeakFor(deps, intent);
			// The SDK's own setup, which routeEncryptionSetups puts this one in front of
			await Intent.prototype.enableEncryption.call(intent);
			uniqueToDeviceTransactions(intent.underlyingClient);
		})().catch((err: unknown) => {
			setups.delete(intent);
			forgetSdkSetup(intent);
			// What failed and where, never what the homeserver answered: the SDK may throw the whole
			// response, its request and its token with it
			deps.log.error(
				{ userId: intent.userId, status: statusOf(err), rejection: describeRejection(err) },
				'encryption setup failed'
			);
			throw err;
		});
		setups.set(intent, setup);
		return setup;
	};
}

// The SDK also sets up by itself the encryption of the users a push names, through the intents it
// hands out: Synapse names a user with a cross-signing identity even before it has a device, since
// it keeps the identity's keys as hidden devices, as for a user another application left behind.
// Each intent is given the setup above instead of the SDK's, so that no setup comes first without
// a device to speak for. A setup that fails inside a push still leaves that push unanswered.
export function routeEncryptionSetups(
	appservice: Appservice,
	ensureEncryption: EnsureEncryption
): void {
	const intentOf = appservice.getIntentForUserId.bind(appservice);
	const routed = new WeakSet<Intent>();
	appservice.getIntentForUserId = (userId: string): Intent => {
		const intent = intentOf(userId);
		if (!routed.has(intent)) {
			routed.add(intent);
			intent.enableEncryption = () => ensureEncryption(intent);
		}
		return intent;
	};
}
