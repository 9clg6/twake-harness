import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

describe('the time limit of a model call', () => {
	const base = {
		HARNESS_ROLE: 'api',
		DATABASE_URL: 'postgres://x@localhost/x',
		AUTH_JWKS_URL: 'https://example.test/jwks',
		AUTH_ISSUER: 'https://example.test/',
		AUTH_AUDIENCE: 'twake-harness',
		APISIX_BASE_URL: 'http://apisix.test',
		APISIX_CONSUMER_KEY: 'k'
	};

	it('is two minutes unless the deployment says otherwise', () => {
		expect(loadConfig(base).llm.timeoutMs).toBe(120_000);
		expect(loadConfig({ ...base, LLM_TIMEOUT_MS: '300000' }).llm.timeoutMs).toBe(300_000);
	});

	// Past five minutes, fetch gives a call up itself, as the headers of the gateway did not come:
	// a longer limit would promise a wait that never happens
	it('refuses, at startup, more than five minutes', () => {
		expect(() => loadConfig({ ...base, LLM_TIMEOUT_MS: '300001' })).toThrow(/LLM_TIMEOUT_MS/);
	});
});
