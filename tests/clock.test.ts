import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { makeSettableClock } from './helpers/clock.js';
import { echoScript } from './helpers/fake-apisix.js';

// The system prompt the scripted model received for one chat turn of this user
async function systemPromptOfTurn(h: TestHarness, sub: string, message: string): Promise<string> {
	h.apisix.llm.script = echoScript;
	const before = h.apisix.llm.calls.length;
	const res = await h.app.inject({
		method: 'POST',
		url: '/v1/chat',
		headers: { authorization: `Bearer ${await h.issuer.mint({ sub })}` },
		payload: { message }
	});
	expect(res.statusCode).toBe(200);
	const system = h.apisix.llm.calls[before]?.request.messages[0];
	expect(system?.role).toBe('system');
	return system?.content ?? '';
}

describe('the present moment in the system prompt', () => {
	describe('a French deployment in Europe/Paris', () => {
		const clock = makeSettableClock('2026-10-06T11:26:00Z');
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

		it("tells the model the date, the time and the offset of the deployment's zone, in French", async () => {
			clock.set('2026-10-06T11:26:00Z');
			const prompt = await systemPromptOfTurn(h, 'alice', 'Suis-je libre à 14h ?');
			expect(prompt).toContain('mardi 6 octobre 2026');
			expect(prompt).toContain('13:26');
			expect(prompt).toContain('2026-10-06T13:26:00+02:00');
			expect(prompt).toContain('Europe/Paris');
		});

		it('states the moment in a block of its own, right after the persona', async () => {
			clock.set('2026-10-06T11:26:00Z');
			const prompt = await systemPromptOfTurn(h, 'alice', 'Et demain ?');
			// The prompt's parts are separated by blank lines; the persona comes first
			expect(prompt.split('\n\n')[1]).toBe(
				[
					'## Maintenant',
					'Date et heure : mardi 6 octobre 2026, 13:26, fuseau Europe/Paris.',
					'En ISO 8601 : 2026-10-06T13:26:00+02:00.',
					"Sers-t'en pour situer « aujourd'hui », « demain » ou « cet après-midi », et donne aux contrats des heures RFC 3339 avec ce décalage."
				].join('\n')
			);
		});

		it('gives the winter offset in winter', async () => {
			clock.set('2026-01-15T09:05:00Z');
			const prompt = await systemPromptOfTurn(h, 'alice', 'Quelle heure est-il ?');
			expect(prompt).toContain('jeudi 15 janvier 2026, 10:05');
			expect(prompt).toContain('2026-01-15T10:05:00+01:00');
		});

		it('follows the switch to summer time within the same night', async () => {
			clock.set('2026-03-29T00:30:00Z');
			expect(await systemPromptOfTurn(h, 'alice', 'Avant')).toContain('2026-03-29T01:30:00+01:00');
			clock.set('2026-03-29T01:30:00Z');
			expect(await systemPromptOfTurn(h, 'alice', 'Après')).toContain('2026-03-29T03:30:00+02:00');
		});

		it('reads the clock again at the start of every turn', async () => {
			clock.set('2026-10-06T11:26:00Z');
			expect(await systemPromptOfTurn(h, 'bob', 'Premier')).toContain('13:26');
			clock.set('2026-10-06T22:30:00Z');
			const later = await systemPromptOfTurn(h, 'bob', 'Second');
			expect(later).toContain('mercredi 7 octobre 2026, 00:30');
			expect(later).not.toContain('13:26');
		});
	});

	describe('a deployment left on its defaults', () => {
		const clock = makeSettableClock('2026-10-06T11:26:00Z');
		let h: TestHarness;
		beforeAll(async () => {
			h = await startTestHarness({ clock });
		});
		afterAll(async () => {
			await h.close();
		});

		it('states the moment in English, in UTC, with an explicit +00:00 offset', async () => {
			const prompt = await systemPromptOfTurn(h, 'alice', 'Am I free at 2pm?');
			expect(prompt).toContain(
				[
					'## Now',
					'Date and time: Tuesday, October 6, 2026, 11:26, time zone UTC.',
					'In ISO 8601: 2026-10-06T11:26:00+00:00.'
				].join('\n')
			);
		});
	});

	describe('the time zone setting', () => {
		const base = {
			HARNESS_ROLE: 'api',
			DATABASE_URL: 'postgres://x@localhost/x',
			AUTH_JWKS_URL: 'https://example.test/jwks',
			AUTH_ISSUER: 'https://example.test/',
			AUTH_AUDIENCE: 'twake-harness',
			APISIX_BASE_URL: 'http://apisix.test',
			APISIX_CONSUMER_KEY: 'k'
		};

		it('refuses a zone the runtime does not know, at startup', () => {
			expect(() => loadConfig({ ...base, ASSISTANT_TIMEZONE: 'Mars/Olympus' })).toThrow(
				'invalid configuration: ASSISTANT_TIMEZONE "Mars/Olympus" is not a time zone the runtime knows'
			);
		});

		it('keeps the canonical name of the zone it is given', () => {
			expect(loadConfig({ ...base, ASSISTANT_TIMEZONE: 'europe/paris' }).timeZone).toBe(
				'Europe/Paris'
			);
			expect(loadConfig(base).timeZone).toBe('UTC');
		});
	});
});
