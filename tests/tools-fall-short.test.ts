import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { organizationPrompt } from '../src/agent/persona.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { echoScript } from './helpers/fake-apisix.js';

// Asked to summarize a PDF that no tool could read, the assistant answered that it could not, and
// offered only to read a text version the owner would make: it is told to say what is missing and
// to offer what its tools can do, never what they cannot
const WHEN_TOOLS_FALL_SHORT =
	'When none of your tools can do what is asked, say so plainly and name what is missing, then offer what your tools can do instead, such as looking for a version of a file that you can read; never offer what they cannot do.';

describe('when none of its tools does what is asked', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness();
	});
	afterAll(async () => {
		await h.close();
	});

	it('the assistant is told to say so and offer what its tools can do instead', async () => {
		h.apisix.llm.script = echoScript;
		const before = h.apisix.llm.calls.length;

		const res = await h.app.inject({
			method: 'POST',
			url: '/v1/chat',
			headers: { authorization: `Bearer ${await h.issuer.mint({ sub: 'alice' })}` },
			payload: { message: 'Summarize the PDF I added to my Drive this morning' }
		});

		expect(res.statusCode).toBe(200);
		expect(h.apisix.llm.calls[before]?.request.messages[0]?.content).toContain(
			WHEN_TOOLS_FALL_SHORT
		);
	});

	it('and so is the organization agent', () => {
		expect(organizationPrompt('Twake Space', 'You help the members of Linagora.')).toContain(
			WHEN_TOOLS_FALL_SHORT
		);
	});
});
