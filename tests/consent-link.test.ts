import { describe, expect, it } from 'vitest';

import { makeOwnerConsentLink } from '../src/contracts/consent-link.js';

describe("the token broker's consent link, bound to the owner it is for", () => {
	it('names the owner exactly, encoded for a query string', () => {
		expect(
			makeOwnerConsentLink('https://agent-consent.test.local/consent', 'alice+work@test.local')
		).toBe('https://agent-consent.test.local/consent?owner=alice%2Bwork%40test.local');
	});

	it("keeps the deployment link's own query and fragment, and replaces an owner it names", () => {
		expect(
			makeOwnerConsentLink(
				'https://agent-consent.test.local/consent?lang=fr&owner=bob%40test.local#top',
				'alice@test.local'
			)
		).toBe('https://agent-consent.test.local/consent?lang=fr&owner=alice%40test.local#top');
	});

	it('gives no link when the deployment gives none', () => {
		expect(makeOwnerConsentLink(null, 'alice@test.local')).toBeNull();
	});
});
