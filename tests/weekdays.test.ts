import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTrueWeekdays } from '../src/agent/weekdays.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeClient } from './helpers/client.js';
import { makeSettableClock } from './helpers/clock.js';
import type { ChatRequest } from './helpers/fake-apisix.js';

// The model works the name of a day out from its date, and gets it wrong: Tuesday 13 October 2026
// once came out as a Monday. The harness names the day of each date the model writes from the
// date itself.
describe('the day of the week of the dates my assistant writes', () => {
	// Friday 9 October 2026, at seven in the morning in Paris
	const clock = makeSettableClock('2026-10-09T05:03:00Z');
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness({
			env: { ASSISTANT_TIMEZONE: 'Europe/Paris', ASSISTANT_LOCALE: 'fr' },
			clock
		});
	});
	afterAll(async () => {
		await h.close();
	});

	it('names the day of a date from the date, whatever day the model wrote, and the conversation keeps it', async () => {
		h.apisix.llm.script = (request: ChatRequest) =>
			request.messages.at(-1)?.content === 'Accepte-la'
				? {
						content:
							"C'est accepté : l'invitation du lundi 13 octobre 2026 de 17:00 à 18:00 est dans ton agenda."
					}
				: { content: 'Avec plaisir.' };
		const c = makeClient(h);
		const res = await c.post<{ answer: string; session_id: string }>('alice', '/v1/chat', {
			message: 'Accepte-la'
		});
		expect(res.body.answer).toBe(
			"C'est accepté : l'invitation du mardi 13 octobre 2026 de 17:00 à 18:00 est dans ton agenda."
		);
		const before = h.apisix.llm.calls.length;
		await c.post('alice', '/v1/chat', { message: 'Merci', session_id: res.body.session_id });
		expect(h.apisix.llm.calls[before]?.request.messages).toContainEqual({
			role: 'assistant',
			content: res.body.answer
		});
	});

	it('names the day of a date written without its year in the year nearest to my day', async () => {
		h.apisix.llm.script = () => ({ content: 'Ta réunion est lundi 13 octobre à 17 h.' });
		const said = async (): Promise<string> =>
			(
				await makeClient(h).post<{ answer: string }>('alice', '/v1/chat', {
					message: 'Quand est ma réunion ?'
				})
			).body.answer;
		expect(await said()).toBe('Ta réunion est mardi 13 octobre à 17 h.');
		// A year earlier, the 13th of October was a Monday
		clock.set('2025-10-09T05:03:00Z');
		try {
			expect(await said()).toBe('Ta réunion est lundi 13 octobre à 17 h.');
		} finally {
			clock.set('2026-10-09T05:03:00Z');
		}
	});

	it('quotes the words the model wrote beside a call that waits for me with the day of each date named from it', async () => {
		h.apisix.contracts.spec = {
			openapi: '3.0.3',
			paths: {
				'/contracts/v1/calendar/invitations/{event_id}/accept': {
					post: {
						operationId: 'accept_invitation',
						summary: 'Accepts an invitation, once the user has said yes to this very invitation',
						tags: ['calendar.invitation.accept.v1'],
						'x-twake-risk': 'low',
						parameters: [
							{ name: 'event_id', in: 'path', required: true, schema: { type: 'string' } }
						]
					}
				}
			}
		};
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(1);
		h.apisix.llm.script = () => ({
			content: "J'accepte l'invitation du lundi 13 octobre 2026 de 17 h à 18 h.",
			toolCalls: [
				{
					id: 'call_accept',
					type: 'function',
					function: { name: 'accept_invitation', arguments: '{"event_id":"uid-point"}' }
				}
			]
		});
		const res = await makeClient(h).post<{ answer: string }>('bob', '/v1/chat', {
			message: "Accepte l'invitation au point"
		});
		expect(res.body.answer).toContain(
			"Ton assistant a écrit :\n> J'accepte l'invitation du mardi 13 octobre 2026 de 17 h à 18 h."
		);
		expect(h.apisix.contracts.calls).toHaveLength(0);
	});
});

// How the model writes a date, in the languages the harness speaks
describe('the day of the week of a date as the model writes it', () => {
	// Friday 9 October 2026
	const today = '2026-10-09';

	it('names the day of a date written in English, its month first or its day first', () => {
		expect(withTrueWeekdays('See you on Monday, October 13, 2026 at 5 pm.', today)).toBe(
			'See you on Tuesday, October 13, 2026 at 5 pm.'
		);
		expect(withTrueWeekdays('Your meeting is on Monday 13 October.', today)).toBe(
			'Your meeting is on Tuesday 13 October.'
		);
		expect(withTrueWeekdays('It moved to Monday the 2nd of November.', today)).toBe(
			'It moved to Monday the 2nd of November.'
		);
		expect(withTrueWeekdays('It moved to Sunday, November 2nd.', today)).toBe(
			'It moved to Monday, November 2nd.'
		);
	});

	it('writes the day it names in the case the model wrote its own', () => {
		expect(withTrueWeekdays('Lundi 13 octobre 2026 : point E2E.', today)).toBe(
			'Mardi 13 octobre 2026 : point E2E.'
		);
		expect(withTrueWeekdays('LUNDI 13 OCTOBRE', today)).toBe('MARDI 13 OCTOBRE');
		expect(withTrueWeekdays('see you monday, october 13', today)).toBe(
			'see you tuesday, october 13'
		);
	});

	it('reads the first of a month as French writes it', () => {
		expect(withTrueWeekdays('Le bilan était le mercredi 1er octobre 2026.', today)).toBe(
			'Le bilan était le jeudi 1er octobre 2026.'
		);
	});

	it('reads a French date written after its day and a comma', () => {
		expect(withTrueWeekdays('C’est accepté pour lundi, 13 octobre 2026 à 17 h.', today)).toBe(
			'C’est accepté pour mardi, 13 octobre 2026 à 17 h.'
		);
		expect(withTrueWeekdays('Lundi, 13 octobre : point E2E.', today)).toBe(
			'Mardi, 13 octobre : point E2E.'
		);
	});

	it('reads a French date written after its day and « le »', () => {
		expect(withTrueWeekdays('Rendez-vous lundi le 13 octobre à 17 h.', today)).toBe(
			'Rendez-vous mardi le 13 octobre à 17 h.'
		);
		expect(withTrueWeekdays('LUNDI LE 13 OCTOBRE 2026', today)).toBe('MARDI LE 13 OCTOBRE 2026');
		expect(withTrueWeekdays('C’est noté pour lundi, le 13 octobre.', today)).toBe(
			'C’est noté pour mardi, le 13 octobre.'
		);
	});

	it('leaves a day that is right, a date there is not, and a day without a date as written', () => {
		for (const words of [
			'Ta réunion est mardi 13 octobre 2026 à 17 h, et Noël vendredi 25 décembre.',
			'Your meeting is on Tuesday, October 13, 2026.',
			'Le lundi 31 novembre 2026 n’existe pas.',
			'Une réunion jeudi 14h30, puis lundi à 17 h.',
			'Le point du lundi 13 est déplacé.'
		]) {
			expect(withTrueWeekdays(words, today)).toBe(words);
		}
	});

	it('takes the day the model wrote for a date without its year that is half a year away, either way', () => {
		// The 9th of April was a Thursday in 2026, and is a Friday in 2027
		expect(withTrueWeekdays('jeudi 9 avril', today)).toBe('jeudi 9 avril');
		expect(withTrueWeekdays('vendredi 9 avril', today)).toBe('vendredi 9 avril');
		expect(withTrueWeekdays('lundi 9 avril', today)).toBe('vendredi 9 avril');
	});
});
