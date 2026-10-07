import { isSignedBy } from './signed-json.js';

// A device of a user as the homeserver publishes it, its signatures checked
export interface PublishedDevice {
	readonly deviceId: string;
	readonly curve25519: string;
	readonly ed25519: string;
	// Whether the user's self-signing key, itself signed by their master key, signed the device
	readonly crossSigned: boolean;
}

// A user's keys as the homeserver publishes them: their cross-signing identity, by its master
// public key, null when they have none, and those of their devices whose own signature holds
export interface PublishedKeys {
	readonly masterKey: string | null;
	readonly devices: readonly PublishedDevice[];
}

// Who encrypted an event, as the encryption engine of the assistant read it: the event's
// sender, the device the engine tied the room key to when it knew it, the keys of the device that
// sent that room key, and the engine's own verdict on the link between them
export interface EventSender {
	readonly userId: string | null;
	readonly deviceId: string | null;
	readonly curve25519Key: string | null;
	readonly ed25519Key: string | null;
	// The engine cannot tell where the room key came from, or it came from another user's device
	readonly unauthenticated: boolean;
}

// The device that encrypted an event, as the published keys tell it, or as the engine named it
// when none of the user's published devices has the keys of the one that sent the room key
export interface SenderDevice {
	readonly deviceId: string | null;
	// Whether the user's cross-signing identity, as published, signed that device
	readonly signed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The one public key of a cross-signing key for a usage, its id naming it as Matrix requires
function crossSigningKey(entry: unknown, userId: string, usage: string): string | null {
	if (!isRecord(entry) || entry['user_id'] !== userId) return null;
	const usages = entry['usage'];
	if (!Array.isArray(usages) || !usages.includes(usage)) return null;
	const keys = entry['keys'];
	if (!isRecord(keys)) return null;
	const pairs = Object.entries(keys);
	const [pair] = pairs;
	if (pairs.length !== 1 || pair === undefined) return null;
	const [keyId, key] = pair;
	return typeof key === 'string' && keyId === `ed25519:${key}` ? key : null;
}

function publishedDevice(
	entry: unknown,
	userId: string,
	deviceId: string,
	selfSigningKey: string | null
): PublishedDevice | null {
	if (!isRecord(entry) || entry['user_id'] !== userId || entry['device_id'] !== deviceId) {
		return null;
	}
	const keys = entry['keys'];
	if (!isRecord(keys)) return null;
	const curve25519 = keys[`curve25519:${deviceId}`];
	const ed25519 = keys[`ed25519:${deviceId}`];
	if (typeof curve25519 !== 'string' || typeof ed25519 !== 'string') return null;
	if (!isSignedBy(entry, userId, `ed25519:${deviceId}`, ed25519)) return null;
	const crossSigned =
		selfSigningKey !== null &&
		isSignedBy(entry, userId, `ed25519:${selfSigningKey}`, selfSigningKey);
	return { deviceId, curve25519, ed25519, crossSigned };
}

// Reads a user's keys from the homeserver's answer to a keys query, checking every signature
// itself: a key whose signatures do not hold counts for nothing
export function readPublishedKeys(reply: unknown, userId: string): PublishedKeys {
	const fields = isRecord(reply) ? reply : {};
	const masterEntry = isRecord(fields['master_keys']) ? fields['master_keys'][userId] : undefined;
	const masterKey = crossSigningKey(masterEntry, userId, 'master');
	const selfSigningEntry = isRecord(fields['self_signing_keys'])
		? fields['self_signing_keys'][userId]
		: undefined;
	const candidate = crossSigningKey(selfSigningEntry, userId, 'self_signing');
	const selfSigningKey =
		masterKey !== null &&
		candidate !== null &&
		isRecord(selfSigningEntry) &&
		isSignedBy(selfSigningEntry, userId, `ed25519:${masterKey}`, masterKey)
			? candidate
			: null;
	const deviceEntries =
		isRecord(fields['device_keys']) && isRecord(fields['device_keys'][userId])
			? Object.entries(fields['device_keys'][userId])
			: [];
	const devices = deviceEntries
		.map(([deviceId, entry]) => publishedDevice(entry, userId, deviceId, selfSigningKey))
		.filter((device): device is PublishedDevice => device !== null);
	return { masterKey, devices };
}

// The device of the user that encrypted an event: the one whose keys are those of the device the
// room key came from, and the device the engine named when it named one
export function senderDevice(
	sender: EventSender,
	keys: PublishedKeys,
	userId: string
): SenderDevice {
	const unknown: SenderDevice = { deviceId: sender.deviceId, signed: false };
	if (sender.unauthenticated || sender.userId !== userId) return unknown;
	if (sender.curve25519Key === null || sender.ed25519Key === null) return unknown;
	const device = keys.devices.find((d) => d.curve25519 === sender.curve25519Key);
	if (device === undefined) return unknown;
	if (sender.deviceId !== null && device.deviceId !== sender.deviceId) return unknown;
	return {
		deviceId: device.deviceId,
		signed: device.ed25519 === sender.ed25519Key && device.crossSigned
	};
}
