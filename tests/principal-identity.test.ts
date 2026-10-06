import { describe, expect, it } from 'vitest';

import { loadConfig, type Config } from '../src/config.js';
import {
	matrixLocalpartOfPrincipal,
	matrixUserIdOfPrincipal,
	principalOfMatrixUser
} from '../src/principals/identity.js';

function configWith(env: Record<string, string>): Config {
	return loadConfig({
		HARNESS_ROLE: 'api',
		DATABASE_URL: 'postgres://x',
		AUTH_JWKS_URL: 'https://issuer.example/jwks',
		AUTH_ISSUER: 'https://issuer.example/',
		AUTH_AUDIENCE: 'twake-harness',
		APISIX_BASE_URL: 'http://apisix',
		APISIX_CONSUMER_KEY: 'k',
		MATRIX_SERVER_NAME: 'test.local',
		...env
	});
}

describe('one person, one principal: the email', () => {
	const config = configWith({});

	it('maps a user of the homeserver to the email of the same person', () => {
		expect(principalOfMatrixUser(config, '@alice:test.local')).toBe('alice@test.local');
		expect(matrixLocalpartOfPrincipal(config, 'alice@test.local')).toBe('alice');
		expect(matrixUserIdOfPrincipal(config, 'bob@test.local')).toBe('@bob:test.local');
	});

	it('uses the mail domain of the platform when it differs from the server name', () => {
		const other = configWith({ MATRIX_MAIL_DOMAIN: 'mail.example' });
		expect(other.matrix.mailDomain).toBe('mail.example');
		expect(principalOfMatrixUser(other, '@alice:test.local')).toBe('alice@mail.example');
		expect(matrixLocalpartOfPrincipal(other, 'alice@mail.example')).toBe('alice');
		expect(matrixLocalpartOfPrincipal(other, 'alice@test.local')).toBeNull();
	});

	it('knows nobody from another homeserver or with an unusable localpart', () => {
		expect(principalOfMatrixUser(config, '@alice:other.local')).toBeNull();
		expect(principalOfMatrixUser(config, '@Al ice:test.local')).toBeNull();
		expect(principalOfMatrixUser(config, 'alice')).toBeNull();
	});

	it('gives no account on the homeserver to a principal of another domain', () => {
		expect(matrixLocalpartOfPrincipal(config, 'alice')).toBeNull();
		expect(matrixLocalpartOfPrincipal(config, 'alice@other.org')).toBeNull();
		expect(matrixLocalpartOfPrincipal(config, 'Al ice@test.local')).toBeNull();
		expect(matrixLocalpartOfPrincipal(config, '@test.local')).toBeNull();
		expect(matrixUserIdOfPrincipal(config, 'alice@other.org')).toBeNull();
	});
});
