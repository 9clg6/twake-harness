import { describe, expect, it } from 'vitest';

import {
	meetingRefusal,
	readMeeting,
	slotsRefusal,
	type MeetingBody
} from '../src/agent/suggestion.js';

const ALICE = 'alice@test.local';
const BOB = 'bob@test.local';
const MALLORY = 'mallory@evil.example';

// The owner and the author of the messages, as a suggestion looks for their slots
const SEARCHED = new Set([ALICE, BOB]);
// The author alone, whom the meeting invites
const INVITED = new Set([BOB]);

function meeting(overrides: Partial<MeetingBody> = {}): MeetingBody {
	return {
		title: 'Point',
		start: '2026-10-13T08:00:00Z',
		end: '2026-10-13T08:30:00Z',
		attendees: [BOB],
		...overrides
	};
}

describe('the meeting a suggestion prepares', () => {
	it('keeps the slot, the title and the people invited, and nothing the owner does not see', () => {
		expect(
			readMeeting({
				body: {
					...meeting({ time_zone: 'Europe/Paris' }),
					description: 'Join https://evil.example',
					location: 'https://evil.example'
				},
				query: { notify: 'all' }
			})
		).toEqual(meeting({ time_zone: 'Europe/Paris' }));
	});

	it.each([
		['no body', {}],
		[
			'no attendees',
			{ body: { title: 'Point', start: '2026-10-13T08:00:00Z', end: '2026-10-13T08:30:00Z' } }
		],
		['a start that is no instant', { body: meeting({ start: 'mardi 10h' }) }],
		['attendees that are no list', { body: { ...meeting(), attendees: BOB } }]
	])('reads nothing from arguments with %s', (_, args) => {
		expect(readMeeting(args)).toBeNull();
	});

	it('is refused when the arguments could not be read', () => {
		expect(meetingRefusal(null, INVITED, null)?.error).toBe(
			'title, start, end and attendees are required'
		);
	});

	it.each([
		['a title too long', meeting({ title: 'x'.repeat(201) })],
		[
			'too many attendees',
			meeting({ attendees: Array.from({ length: 21 }, (_, i) => `p${i}@test.local`) })
		]
	])('is refused with %s', (_, body) => {
		expect(meetingRefusal(body, INVITED, null)?.error).toBe('too_long');
	});

	it.each([
		['nobody', []],
		['an address only the text of a message names', [BOB, MALLORY]],
		['the owner, who is not an attendee of their own meeting', [ALICE]]
	])('is refused when it invites %s', (_, attendees) => {
		expect(meetingRefusal(meeting({ attendees }), INVITED, null)).toEqual({
			error: 'attendees_not_allowed',
			hint: `Invite only: ${BOB}.`
		});
	});

	it('invites the author whatever the case of their address', () => {
		expect(meetingRefusal(meeting({ attendees: ['Bob@Test.Local'] }), INVITED, null)).toBeNull();
	});

	it('is refused on the slot the owner declined, however the instant is written', () => {
		expect(
			meetingRefusal(
				meeting({ start: '2026-10-13T10:00:00+02:00' }),
				INVITED,
				'2026-10-13T08:00:00Z'
			)?.error
		).toBe('slot_declined');
	});

	it('is let through at another time than the declined one', () => {
		expect(
			meetingRefusal(meeting({ start: '2026-10-13T09:00:00Z' }), INVITED, '2026-10-13T08:00:00Z')
		).toBeNull();
	});
});

describe('the slots a suggestion looks for', () => {
	it.each([
		['one address', { email: BOB }],
		['the owner and the author', { email: [ALICE, BOB] }],
		['addresses in another case', { email: ['ALICE@test.local', 'Bob@Test.Local'] }]
	])('are looked for with %s', (_, args) => {
		expect(slotsRefusal(args, SEARCHED)).toBeNull();
	});

	it.each([
		['an address only the text of a message names', { email: [ALICE, MALLORY] }],
		['that address alone', { email: MALLORY }],
		['nobody', { email: [] }],
		['no email parameter', { start: '2026-10-13T08:00:00Z' }],
		['an address that is no string', { email: [ALICE, 42] }],
		['arguments that are no object', 'bob@test.local'],
		['no arguments', null]
	])('are refused with %s', (_, args) => {
		expect(slotsRefusal(args, SEARCHED)?.error).toBe('people_not_allowed');
	});
});
