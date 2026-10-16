import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { makeRichText } from '../src/matrix/format.js';
import { isYesNoQuestion, markQuestion } from '../src/matrix/questions.js';
import { makeMeetingContext } from '../src/suggestions/text.js';
import { QUESTION_CONTENT_KEY } from './helpers/consent-room.js';

const config = loadConfig({
	HARNESS_ROLE: 'api',
	DATABASE_URL: 'postgres://x',
	AUTH_JWKS_URL: 'https://issuer.example/jwks',
	AUTH_ISSUER: 'https://issuer.example/',
	AUTH_AUDIENCE: 'twake-harness',
	APISIX_BASE_URL: 'http://apisix',
	APISIX_CONSUMER_KEY: 'k',
	MATRIX_SERVER_NAME: 'test.local'
});
const content = makeRichText('Schedule?');
const proposal = {
	title: `  Salon\n avec Michel ${'x'.repeat(100)}`,
	start: '2026-10-15T06:00:00.000Z',
	end: '2026-10-15T06:30:00.000Z',
	attendees: ['alice@test.local', 'Bob@test.local', 'bob@test.local', 'eve@elsewhere.org']
};

describe('the marker of a yes or no question', () => {
	it('carries the context of a proposed meeting', () => {
		const meeting = makeMeetingContext(config, 'alice@test.local', '!room:test.local', proposal);
		const marked = markQuestion(content, { id: 'c1', expiresTs: 5, meeting });
		expect(marked).toHaveProperty('body', 'Schedule?');
		expect(marked).toHaveProperty([QUESTION_CONTENT_KEY], {
			id: 'c1',
			expires_ts: 5,
			kind: 'meeting',
			room_id: '!room:test.local',
			with: ['@bob:test.local'],
			start_ts: Date.parse(proposal.start),
			end_ts: Date.parse(proposal.end),
			title: meeting.title
		});
		expect(Array.from(meeting.title)).toHaveLength(80);
		expect(meeting.title).toMatch(/^Salon avec Michel x/);
	});

	it('carries nothing more on any other question', () => {
		expect(markQuestion(content, { id: 'c2', expiresTs: 7 })).toHaveProperty(
			[QUESTION_CONTENT_KEY],
			{
				id: 'c2',
				expires_ts: 7
			}
		);
	});

	it('reads back a question with its whole meeting, or none', () => {
		const meeting = makeMeetingContext(config, 'alice@test.local', '!room:test.local', proposal);
		expect(isYesNoQuestion({ id: 'c1', expiresTs: 5, meeting })).toBe(true);
		expect(isYesNoQuestion({ id: 'c1', expiresTs: 5 })).toBe(true);
		expect(isYesNoQuestion({ id: 'c1', expiresTs: 5, meeting: null })).toBe(false);
		expect(isYesNoQuestion({ id: 'c1', expiresTs: 5, meeting: { ...meeting, title: 3 } })).toBe(
			false
		);
		expect(
			isYesNoQuestion({ id: 'c1', expiresTs: 5, meeting: { ...meeting, invitees: [1] } })
		).toBe(false);
	});
});
