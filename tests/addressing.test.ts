import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';
import { echoScript } from './helpers/fake-apisix.js';

const TUTOIEMENT = "Tutoie la personne qui t'écrit";

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
	return h.apisix.llm.calls[before]?.request.messages[0]?.content ?? '';
}

describe('how the assistant addresses the person it talks to', () => {
	describe('in a French deployment', () => {
		let h: TestHarness;
		beforeAll(async () => {
			h = await startTestHarness({ env: { ASSISTANT_LOCALE: 'fr' } });
		});
		afterAll(async () => {
			await h.close();
		});

		it('tells the model, in French, to say "tu" and never "vous" unless asked to', async () => {
			const prompt = await systemPromptOfTurn(h, 'alice', 'Bonjour');
			expect(prompt).toContain(
				"Tutoie la personne qui t'écrit : adresse-toi à elle avec « tu », simplement, et jamais avec « vous », sauf si elle te demande explicitement de la vouvoyer."
			);
		});
	});

	describe('in an English deployment', () => {
		let h: TestHarness;
		beforeAll(async () => {
			h = await startTestHarness();
		});
		afterAll(async () => {
			await h.close();
		});

		it('gives the model no such instruction', async () => {
			const prompt = await systemPromptOfTurn(h, 'alice', 'Hello');
			expect(prompt).not.toContain(TUTOIEMENT);
			expect(prompt).not.toContain('vous');
		});
	});
});
