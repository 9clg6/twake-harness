import { describe, expect, it } from 'vitest';

import { getMessages } from '../src/i18n/messages.js';

// The turn an invitation starts reads text its organizer wrote, so what it is told to do must
// leave nothing to guess: read, check the slot without the invitation counting against itself,
// say it, ask, stop
describe('the message an invitation event gives the model', () => {
	it('tells it, in English, to exclude the invitation by its uid and to end with a question', () => {
		const told = getMessages('en').events.invitation('calendar.invitation', 'evt-1');
		expect(told).toContain('read_event');
		expect(told).toContain('read_freebusy');
		expect(told).toContain('exclude');
		expect(told).toContain('data.object.uid');
		expect(told).toContain('RFC 3339');
		expect(told).toContain('"exclude": "<data.object.uid>"');
		expect(told).toContain('"Do you want me to accept it?"');
		expect(told).toContain('do not accept it yourself');
	});

	it('tells it the same in French, in the voice of the catalog', () => {
		const told = getMessages('fr').events.invitation('calendar.invitation', 'evt-1');
		expect(told).toMatch(/^\[événement\] Un nouvel événement de type « calendar\.invitation »/);
		expect(told).toContain('read_event');
		expect(told).toContain('read_freebusy');
		expect(told).toContain('data.object.uid');
		expect(told).toContain('RFC 3339');
		expect(told).toContain('"exclude": "<data.object.uid>"');
		expect(told).toContain("« Veux-tu que je l'accepte ? »");
		expect(told).toContain("arrête-toi là : ne l'accepte pas toi-même");
	});
});
