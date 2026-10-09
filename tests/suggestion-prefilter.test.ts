import { describe, expect, it } from 'vitest';

import { mayArrangeMeeting } from '../src/suggestions/prefilter.js';

describe('the pre-filter of channel messages', () => {
	it.each([
		'ok on parle lundi',
		'On se voit demain à 10h ?',
		'Une réunion jeudi 14h30 ?',
		'rdv le 12/10 ?',
		"Let's talk on Monday",
		'can we meet tomorrow at 3pm',
		'catch up next week?',
		'Meeting on October 12',
		'on se call le 3 novembre',
		'Quick call at 14:30',
		"peut on se voir lundi à 14h pour softphonie dans l'ECS ?",
		'Je passe te voir demain ?'
	])('lets %j through', (text) => {
		expect(mayArrangeMeeting(text)).toBe(true);
	});

	it.each([
		'ok pour moi',
		'Merci pour le document',
		'lundi je suis en congé',
		'the release is on Friday',
		'on parle de quoi ?',
		'Rendez-vous compte du problème',
		'I called it at 5pm yesterday and nothing',
		'',
		`on parle lundi ${'x'.repeat(700)}`
	])('keeps %j out', (text) => {
		expect(mayArrangeMeeting(text)).toBe(false);
	});
});
