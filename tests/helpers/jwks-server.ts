import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

export interface Claims {
	sub?: string;
	iss?: string;
	aud?: string;
	iat?: number;
	exp?: number;
}

export interface TestIssuer {
	readonly jwksUrl: URL;
	readonly issuer: string;
	readonly audience: string;
	mint(overrides?: Claims): Promise<string>;
	mintWithForeignKey(overrides?: Claims): Promise<string>;
	mintUnsigned(overrides?: Claims): string;
	close(): Promise<void>;
}

function base64url(input: string): string {
	return Buffer.from(input).toString('base64url');
}

function makeClaims(issuer: string, audience: string, overrides: Claims): Record<string, unknown> {
	const now = Math.floor(Date.now() / 1000);
	return {
		sub: 'alice',
		iss: issuer,
		aud: audience,
		iat: now,
		exp: now + 3600,
		...overrides
	};
}

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

async function signWith(
	key: SigningKey,
	kid: string,
	claims: Record<string, unknown>
): Promise<string> {
	return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).sign(key);
}

export async function startTestIssuer(): Promise<TestIssuer> {
	const issuer = 'https://oidc-test.local';
	const audience = 'twake-harness';
	const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
	const foreign = await generateKeyPair('RS256', { modulusLength: 2048 });
	const kid = 'test-key';
	const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
	const server: Server = createServer((_req, res) => {
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({ keys: [jwk] }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('test issuer did not bind to a TCP port');
	}
	const jwksUrl = new URL(`http://127.0.0.1:${address.port}/jwks.json`);
	return {
		jwksUrl,
		issuer,
		audience,
		mint: (overrides = {}) => signWith(privateKey, kid, makeClaims(issuer, audience, overrides)),
		mintWithForeignKey: (overrides = {}) =>
			signWith(foreign.privateKey, kid, makeClaims(issuer, audience, overrides)),
		mintUnsigned: (overrides = {}) =>
			`${base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64url(
				JSON.stringify(makeClaims(issuer, audience, overrides))
			)}.`,
		close: () =>
			new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
	};
}
