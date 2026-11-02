import { describe, expect, it } from 'vitest';

import { withoutCallMarkup } from '../src/agent/call-markup.js';

const CALL = '{"name": "consents_list", "arguments": {}}';
const BLOCK = `<tool_call>\n${CALL}\n</tool_call>`;

describe('the words of a text that ends on a call written in it', () => {
	it('are what comes before the call, in its tags, open or closed, or in JSON', () => {
		expect(withoutCallMarkup(`Here is what I found.\n${BLOCK}`)).toBe('Here is what I found.');
		expect(withoutCallMarkup(`Here is what I found.\n<tool_call>\n{"name": "consents_li`)).toBe(
			'Here is what I found.'
		);
		expect(withoutCallMarkup(`Here is what I found.\n${CALL}`)).toBe('Here is what I found.');
		expect(
			withoutCallMarkup(
				'Here is what I found.\n{\n  "name": "consents_list",\n  "arguments": {}\n}'
			)
		).toBe('Here is what I found.');
		expect(withoutCallMarkup(`Two calls.\n${BLOCK}\n<function_call>${CALL}</function_call>`)).toBe(
			'Two calls.'
		);
	});

	it('are nothing when the text holds nothing else', () => {
		expect(withoutCallMarkup(BLOCK)).toBe('');
		expect(withoutCallMarkup(CALL)).toBe('');
		expect(withoutCallMarkup(`[${CALL}]`)).toBe('');
		expect(
			withoutCallMarkup(
				'```json\n[{"type": "function", "function": {"name": "consents_list", "arguments": "{}"}}]\n```'
			)
		).toBe('');
	});

	it('keep a tag or a call the model speaks of among its words', () => {
		const explained = 'Use the <tool_call> tag to ask for a tool, then wait for its result.';
		expect(withoutCallMarkup(explained)).toBe(explained);
		const shown = `A call looks like this:\n\`\`\`json\n${CALL}\n\`\`\``;
		expect(withoutCallMarkup(shown)).toBe(shown);
		expect(withoutCallMarkup(`I use <tool_call> tags. Done.\n${BLOCK}`)).toBe(
			'I use <tool_call> tags. Done.'
		);
		expect(
			withoutCallMarkup('I use <tool_call> tags. Done.\n<tool_call>\n{"name": "consents_li')
		).toBe('I use <tool_call> tags. Done.');
		const data = 'Your contacts:\n{"name":"Alice","parameters":{"age":3}}\nand that is all.';
		expect(withoutCallMarkup(data)).toBe(data);
		const between = `First.\n${BLOCK}\nThen more words.`;
		expect(withoutCallMarkup(between)).toBe(between);
	});

	it('keep what ends the text but is no call', () => {
		for (const tail of ['[]', '{"arguments": {}}', '{"function": "x"}', '{not json}', '{}']) {
			expect(withoutCallMarkup(`Done.\n${tail}`)).toBe(`Done.\n${tail}`);
		}
	});

	it('are the whole text when it holds no call', () => {
		expect(withoutCallMarkup('  Plain words.\n')).toBe('Plain words.');
		expect(withoutCallMarkup('')).toBe('');
	});
});
