import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { readPublishedKeys, senderDevice, type EventSender } from '../src/matrix/owner-keys.js';
import { canonicalJson } from '../src/matrix/signed-json.js';

// What the homeserver answers to a keys query is read here directly: forging each link of the
// chain at the seam would take a homeserver that lies, which the real one never does

const USER = '@alice:test.local';
const DEVICE = 'TWAKECHAT';

interface Signer {
	readonly publicKey: string;
	readonly privateKey: KeyObject;
}

function unpadded(bytes: Buffer): string {
	return bytes.toString('base64').replace(/=+$/, '');
}

function signer(): Signer {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const { x } = publicKey.export({ format: 'jwk' });
	return { publicKey: unpadded(Buffer.from(x ?? '', 'base64url')), privateKey };
}

// An object signed as Matrix signs it: its canonical form, without its signatures and unsigned part
function signed(
	object: Record<string, unknown>,
	by: Signer,
	keyId: string
): Record<string, unknown> {
	const { signatures, unsigned: _unsigned, ...content } = object;
	const signature = unpadded(
		sign(null, Buffer.from(canonicalJson(content), 'utf8'), by.privateKey)
	);
	const existing = (signatures ?? {}) as Record<string, Record<string, string>>;
	return {
		...object,
		signatures: { ...existing, [USER]: { ...(existing[USER] ?? {}), [keyId]: signature } }
	};
}

interface Chain {
	readonly master: Signer;
	readonly device: Signer;
	readonly curve25519: string;
	readonly reply: Record<string, unknown>;
}

// Alice's identity and one device of hers, as the homeserver publishes them, each link signed by
// the key Matrix requires unless a test says otherwise
function chain(
	forged: {
		readonly selfSigningSignedBy?: Signer;
		readonly deviceSignedBy?: Signer;
		readonly masterKeyId?: string;
	} = {}
): Chain {
	const master = signer();
	const selfSigning = signer();
	const device = signer();
	const curve25519 = unpadded(randomBytes(32));
	const masterKey = signed(
		{
			user_id: USER,
			usage: ['master'],
			keys: { [forged.masterKeyId ?? `ed25519:${master.publicKey}`]: master.publicKey }
		},
		device,
		`ed25519:${DEVICE}`
	);
	const selfSigningKey = signed(
		{
			user_id: USER,
			usage: ['self_signing'],
			keys: { [`ed25519:${selfSigning.publicKey}`]: selfSigning.publicKey }
		},
		forged.selfSigningSignedBy ?? master,
		`ed25519:${master.publicKey}`
	);
	const deviceKeys = signed(
		signed(
			{
				user_id: USER,
				device_id: DEVICE,
				algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
				keys: { [`curve25519:${DEVICE}`]: curve25519, [`ed25519:${DEVICE}`]: device.publicKey },
				unsigned: { device_display_name: 'Twake Chat' }
			},
			forged.deviceSignedBy ?? device,
			`ed25519:${DEVICE}`
		),
		selfSigning,
		`ed25519:${selfSigning.publicKey}`
	);
	return {
		master,
		device,
		curve25519,
		reply: {
			master_keys: { [USER]: masterKey },
			self_signing_keys: { [USER]: selfSigningKey },
			device_keys: { [USER]: { [DEVICE]: deviceKeys } }
		}
	};
}

// Who encrypted an event, as the engine tells it of the device of the chain
function sender(of: Chain, overrides: Partial<EventSender> = {}): EventSender {
	return {
		userId: USER,
		deviceId: DEVICE,
		curve25519Key: of.curve25519,
		ed25519Key: of.device.publicKey,
		unauthenticated: false,
		...overrides
	};
}

describe("the keys of an owner's sessions as the homeserver publishes them", () => {
	it('takes a device the identity signed through its self-signing key', () => {
		const alice = chain();
		const keys = readPublishedKeys(alice.reply, USER);
		expect(keys.masterKey).toBe(alice.master.publicKey);
		expect(senderDevice(sender(alice), keys, USER)).toEqual({ deviceId: DEVICE, signed: true });
		// Or that the engine did not know yet, found by the key the room key came from
		expect(senderDevice(sender(alice, { deviceId: null }), keys, USER)).toEqual({
			deviceId: DEVICE,
			signed: true
		});
	});

	it('does not take a device whose self-signing key the master key did not sign', () => {
		const alice = chain({ selfSigningSignedBy: signer() });
		const keys = readPublishedKeys(alice.reply, USER);
		expect(keys.masterKey).toBe(alice.master.publicKey);
		expect(senderDevice(sender(alice), keys, USER).signed).toBe(false);
	});

	it('does not take a device whose own signature does not hold', () => {
		const alice = chain({ deviceSignedBy: signer() });
		const keys = readPublishedKeys(alice.reply, USER);
		expect(keys.devices).toEqual([]);
		expect(senderDevice(sender(alice), keys, USER).signed).toBe(false);
	});

	it('does not take a device whose keys changed after they were signed', () => {
		const alice = chain();
		const published = alice.reply['device_keys'] as Record<
			string,
			Record<string, Record<string, unknown>>
		>;
		const device = published[USER]?.[DEVICE] ?? {};
		const swapped = unpadded(randomBytes(32));
		const reply = {
			...alice.reply,
			device_keys: {
				[USER]: {
					[DEVICE]: {
						...device,
						keys: { ...(device['keys'] as object), [`curve25519:${DEVICE}`]: swapped }
					}
				}
			}
		};
		const keys = readPublishedKeys(reply, USER);
		expect(keys.devices).toEqual([]);
		expect(senderDevice(sender(alice, { curve25519Key: swapped }), keys, USER).signed).toBe(false);
	});

	it('does not take a room key that came under another signing key than the published one', () => {
		const alice = chain();
		const keys = readPublishedKeys(alice.reply, USER);
		expect(senderDevice(sender(alice, { ed25519Key: signer().publicKey }), keys, USER)).toEqual({
			deviceId: DEVICE,
			signed: false
		});
	});

	it('does not take a room key whose origin the engine cannot tell, nor one of another user', () => {
		const alice = chain();
		const keys = readPublishedKeys(alice.reply, USER);
		expect(senderDevice(sender(alice, { unauthenticated: true }), keys, USER).signed).toBe(false);
		expect(senderDevice(sender(alice, { userId: '@mallory:test.local' }), keys, USER).signed).toBe(
			false
		);
		expect(senderDevice(sender(alice, { deviceId: 'ANOTHER' }), keys, USER).signed).toBe(false);
	});

	it('reads no identity from a master key its id does not name, nor from another user', () => {
		const misnamed = chain({ masterKeyId: `ed25519:${signer().publicKey}` });
		const keys = readPublishedKeys(misnamed.reply, USER);
		expect(keys.masterKey).toBeNull();
		expect(senderDevice(sender(misnamed), keys, USER).signed).toBe(false);
		expect(readPublishedKeys(chain().reply, '@bob:test.local')).toEqual({
			masterKey: null,
			devices: []
		});
	});
});
