import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';
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
	return h.apisix.llm.calls[before]?.request.messages[0]?.content ?? '';
}

// The contracts service no longer stores events: its read_event and list_events are gone, and an
// invitation reaches the assistant with its turn
describe('my assistant is never sent to look an invitation up with the contracts that are gone', () => {
	for (const locale of ['en', 'fr'] as const) {
		describe(`in a deployment that speaks ${locale}`, () => {
			let h: TestHarness;
			beforeAll(async () => {
				h = await startTestHarness({ env: { ASSISTANT_LOCALE: locale } });
			});
			afterAll(async () => {
				await h.close();
			});

			it('names neither list_events nor read_event to the model', async () => {
				const prompt = await systemPromptOfTurn(h, 'alice', "Accept Paul's invitation");
				expect(prompt).not.toContain('list_events');
				expect(prompt).not.toContain('read_event');
			});
		});
	}
});
