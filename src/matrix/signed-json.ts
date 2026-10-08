import { createPublicKey, verify } from 'node:crypto';

// Matrix signs the canonical form of a JSON object: its keys sorted, no space, and neither its
// signatures nor its unsigned part
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (typeof value === 'object' && value !== null) {
		const record = value as Record<string, unknown>;
		const members = Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
		return `{${members.join(',')}}`;
	}
	return JSON.stringify(value);
}

// Matrix writes keys and signatures in base64 without padding; anything else is not one of them
function decodeBase64(value: string, length: number): Buffer | null {
	const bytes = Buffer.from(value, 'base64');
	if (bytes.length !== length) return null;
	return bytes.toString('base64').replace(/=+$/, '') === value ? bytes : null;
}

function verifyEd25519(publicKey: string, message: string, signature: string): boolean {
	const key = decodeBase64(publicKey, 32);
	const signed = decodeBase64(signature, 64);
	if (key === null || signed === null) return false;
	try {
		const verifier = createPublicKey({
			key: { kty: 'OKP', crv: 'Ed25519', x: key.toString('base64url') },
			format: 'jwk'
		});
		return verify(null, Buffer.from(message, 'utf8'), verifier, signed);
	} catch {
		return false;
	}
}

// Whether a signed JSON object carries a valid signature of a user's key, the key being given by
// its public part and its id (`ed25519:<device id>` for a device, `ed25519:<public key>` for a
// cross-signing key)
export function isSignedBy(
	object: Record<string, unknown>,
	userId: string,
	keyId: string,
	publicKey: string
): boolean {
	const signatures: unknown = object['signatures'];
	if (typeof signatures !== 'object' || signatures === null) return false;
	const byUser: unknown = Reflect.get(signatures, userId);
	if (typeof byUser !== 'object' || byUser === null) return false;
	const signature: unknown = Reflect.get(byUser, keyId);
	if (typeof signature !== 'string') return false;
	const { signatures: _signatures, unsigned: _unsigned, ...signed } = object;
	return verifyEd25519(publicKey, canonicalJson(signed), signature);
}
