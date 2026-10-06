import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { readCatalog, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import type { ChatRequest, ScriptedReply, ToolCall } from './helpers/fake-apisix.js';

const DOMAINS = ['mail', 'drive', 'calendar', 'tasks', 'notes'];

function call(name: string, args: unknown): ToolCall[] {
	return [
		{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
	];
}

// A literal model: it calls the tool given for each request it knows, and tells the owner what
// the tool returned
function modelFor(
	requests: Record<string, { readonly tool: string; readonly args: unknown }>
): (request: ChatRequest) => ScriptedReply {
	return (request) => {
		const last = request.messages.at(-1);
		if (last?.role === 'tool') return { content: `Told: ${last.content ?? ''}` };
		const known = last?.role === 'user' ? requests[last.content ?? ''] : undefined;
		return known === undefined
			? { content: 'Heard you' }
			: { toolCalls: call(known.tool, known.args) };
	};
}

describe('I ask my assistant what it may access', () => {
	let r: ConsentRoom;
	beforeAll(async () => {
		r = await startConsentRoom({ ADMISSION_USER_PER_MINUTE: '100' });
		r.h.apisix.contracts.spec = readCatalog(DOMAINS);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(DOMAINS.length);
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});
	beforeEach(() => {
		r.h.apisix.contracts.calls.length = 0;
		r.h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
	});

	// What the assistant told me after my message, as the model above relays a tool's result
	async function told(text: string): Promise<unknown> {
		const seen = r.saying('Told:').length;
		await r.client.sendText(r.room, text);
		return JSON.parse((await r.nextSaying('Told:', seen)).slice('Told: '.length));
	}

	// Lets the assistant read an application, as I do when it first asks
	async function allow(text: string): Promise<void> {
		const seen = r.questions().length;
		await r.client.sendText(r.room, text);
		await r.nextQuestion(seen);
		const found = r.saying('Told:').length;
		await r.client.sendText(r.room, 'yes');
		await r.nextSaying('Told:', found);
	}

	it('tells me what it may access: what I allowed, and its own feed of events', async () => {
		r.h.apisix.llm.script = modelFor({
			'Find the budget in my mail': { tool: 'search_mail', args: { q: 'budget' } },
			'What may you access?': { tool: 'consents_list', args: {} }
		});
		await allow('Find the budget in my mail');
		expect(await told('What may you access?')).toEqual({
			consents: [
				{ domain: 'events', level: 'read', granted_by: 'built_in', granted_at: null },
				{ domain: 'mail', level: 'read', granted_by: 'chat', granted_at: expect.any(String) }
			]
		});
	});
});
