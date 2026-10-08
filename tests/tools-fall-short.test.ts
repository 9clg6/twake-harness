import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { organizationPrompt } from '../src/agent/persona.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';
import { CALENDAR_CATALOG, echoScript } from './helpers/fake-apisix.js';

// Asked to summarize a PDF that no tool could read, the assistant answered that it could not, and
// offered only to read a text version the owner would make: it is told to say what is missing and
// to offer what its tools can do, never what they cannot
const WHEN_TOOLS_FALL_SHORT =
	'When none of your tools can do what is asked, say so plainly and name what is missing, then offer what your tools can do instead; never offer what they cannot do.';
// What it can offer instead, given as an example only when it can look for files
const WITH_FILE_SEARCH =
	'When none of your tools can do what is asked, say so plainly and name what is missing, then offer what your tools can do instead, such as looking for a version of a file that you can read; never offer what they cannot do.';

// The Drive's file search, as the contracts service publishes it behind the gateway
const DRIVE_SEARCH_CATALOG = {
	openapi: '3.1.0',
	paths: {
		'/contracts/v1/drive/files': {
			get: {
				operationId: 'search_files',
				summary: "Find the user's files and folders by name",
				tags: ['drive.file.read.v1'],
				parameters: [{ name: 'name', in: 'query', required: true, schema: { type: 'string' } }]
			}
		}
	}
};

// The system prompt the scripted model received for one chat turn of alice
async function systemPromptOfTurn(h: TestHarness, message: string): Promise<string> {
	h.apisix.llm.script = echoScript;
	const before = h.apisix.llm.calls.length;
	const res = await h.app.inject({
		method: 'POST',
		url: '/v1/chat',
		headers: { authorization: `Bearer ${await h.issuer.mint({ sub: 'alice' })}` },
		payload: { message }
	});
	expect(res.statusCode).toBe(200);
	return h.apisix.llm.calls[before]?.request.messages[0]?.content ?? '';
}

describe('when none of its tools does what is asked', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness();
	});
	afterAll(async () => {
		await h.close();
	});

	it('the assistant is told to say so and offer what its tools can do instead', async () => {
		// Its tools read the calendar: none of them looks for a file
		h.apisix.contracts.spec = CALENDAR_CATALOG;
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(2);

		const prompt = await systemPromptOfTurn(
			h,
			'Summarize the PDF I added to my Drive this morning'
		);

		expect(prompt).toContain(WHEN_TOOLS_FALL_SHORT);
		expect(prompt).not.toContain('a version of a file');
	});

	it('the assistant that can search the files is given looking for a version of the file it can read as an example', async () => {
		// It can look for files in the Drive
		h.apisix.contracts.spec = DRIVE_SEARCH_CATALOG;
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(1);

		const prompt = await systemPromptOfTurn(
			h,
			'Summarize the PDF I added to my Drive this morning'
		);

		expect(prompt).toContain(WITH_FILE_SEARCH);
	});

	it('and so is the organization agent', () => {
		const prompt = organizationPrompt('Twake Space', 'You help the members of Linagora.', [
			'read_freebusy'
		]);

		expect(prompt).toContain(WHEN_TOOLS_FALL_SHORT);
		expect(prompt).not.toContain('a version of a file');
	});

	it('and so is the organization agent that can search the files', () => {
		expect(
			organizationPrompt('Twake Space', 'You help the members of Linagora.', ['search_files'])
		).toContain(WITH_FILE_SEARCH);
	});
});
