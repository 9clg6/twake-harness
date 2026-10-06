import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
	modelFor,
	modelUsing,
	readCatalog,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';
import { startE2eeClient } from './helpers/e2ee-client.js';

const DOMAINS = ['mail', 'drive', 'tasks', 'notes', 'photos', 'boards'];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('I answer the question in words', () => {
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

	it('runs the frozen call when my next message is a plain yes', async () => {
		r.h.apisix.llm.script = modelUsing('search_mail', { q: 'budget' });
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Find the budget in my mail');
		await r.nextQuestion(seen);
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'Yes!');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/mail/items');
		expect(r.h.apisix.contracts.calls.map((c) => c.query)).toEqual([{ q: 'budget' }]);
		// My yes answered the question: no turn of its own told the model about it
		const told = r.h.apisix.llm.calls.flatMap((c) => c.request.messages);
		expect(told.some((m) => m.role === 'user' && m.content === 'Yes!')).toBe(false);
	});

	it('drops the call and tells me so when I answer no, or react ❌', async () => {
		r.h.apisix.llm.script = modelUsing('search_drive', { q: 'plan' });
		let seen = r.questions().length;
		await r.client.sendText(r.room, 'Find my plan in my drive');
		await r.nextQuestion(seen);
		let modelCalls = r.h.apisix.llm.calls.length;
		let acknowledged = r.saying('All right').length;
		await r.client.sendText(r.room, 'No.');
		expect(await r.nextSaying('All right', acknowledged)).toBe('All right, I will not do it.');
		// The harness answered on its own: no model, no contract
		expect(r.h.apisix.llm.calls).toHaveLength(modelCalls);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);

		r.h.apisix.llm.script = modelUsing('search_tasks', { q: 'today' });
		seen = r.questions().length;
		await r.client.sendText(r.room, 'What are my tasks?');
		const question = await r.nextQuestion(seen);
		modelCalls = r.h.apisix.llm.calls.length;
		acknowledged = r.saying('All right').length;
		await r.client.react(r.room, question, '❌');
		expect(await r.nextSaying('All right', acknowledged)).toBe('All right, I will not do it.');
		expect(r.h.apisix.llm.calls).toHaveLength(modelCalls);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
		// A refused call keeps nothing of what it would have sent
		expect(await r.callsTo('drive')).toEqual([{ status: 'refused', arguments: null }]);
		expect(await r.callsTo('tasks')).toEqual([{ status: 'refused', arguments: null }]);
	});

	it('puts two buttons under its question, and a tap on yes allows the call', async () => {
		r.h.apisix.llm.script = modelUsing('search_notes', { q: 'budget' });
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Search my notes for the budget');
		const question = await r.nextQuestion(seen);
		expect(r.questions().at(-1)?.body).toBe(
			'This is the first time I need to read your data in notes. Do you allow it? Answer with the buttons below, or reply yes or no.'
		);
		// The assistant's own reactions on its question are the buttons Twake Chat shows
		const buttons = await r.client.waitForReactions(r.room, question, r.assistantId, 2);
		expect(buttons.sort()).toEqual(['✅ YES', '❌ NO']);
		// A tap on a button sends the same reaction from my account
		const found = r.saying('Found:').length;
		await r.client.react(r.room, question, '✅ YES');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/notes/items');
	});

	it('takes anything else I write for a message, after which only a tap answers', async () => {
		r.h.apisix.llm.script = modelFor({
			'Look for the party in my photos': { tool: 'search_photos', args: { q: 'party' } }
		});
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Look for the party in my photos');
		const question = await r.nextQuestion(seen);
		let heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Which party, by the way?');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: Which party, by the way?');
		// My yes no longer comes right after the question: it is a message like any other
		heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'yes');
		expect(await r.nextSaying('Heard:', heard)).toBe('Heard: yes');
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
		// The question is still open, and its buttons answer it in any language the harness speaks
		const found = r.saying('Found:').length;
		await r.client.react(r.room, question, '✅ OUI');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/photos/items');
	});

	it('ignores a yes from someone else, or sent unencrypted from my account', async () => {
		r.h.apisix.llm.script = modelFor({
			'Show my boards': { tool: 'search_boards', args: { q: 'all' } }
		});
		const bob = await r.h.synapse.registerUser('bob');
		const bobClient = await startE2eeClient(r.h.synapse.url, bob);
		try {
			await r.h.synapse.request(
				r.alice,
				'POST',
				`/_matrix/client/v3/rooms/${encodeURIComponent(r.room)}/invite`,
				{ user_id: bob.userId }
			);
			await bobClient.joinRoom(r.room);
			const seen = r.questions().length;
			await r.client.sendText(r.room, 'Show my boards');
			await r.nextQuestion(seen);
			// Bob, a member of the room, says yes: the assistant reads him and ignores him
			await bobClient.sendText(r.room, 'yes');
			let ignored = false;
			for (let i = 0; i < 120 && !ignored; i += 1) {
				ignored = r.h
					.logLines()
					.some(
						(l) => l['msg'] === 'assistant ignored a foreign sender' && l['sender'] === bob.userId
					);
				if (!ignored) await sleep(250);
			}
			expect(ignored).toBe(true);
			// A yes written in my name without encryption, as a component on the server could, is an
			// ordinary message
			const heard = r.saying('Heard:').length;
			await r.h.synapse.request(
				r.alice,
				'PUT',
				`/_matrix/client/v3/rooms/${encodeURIComponent(r.room)}/send/m.room.message/plain-${Date.now()}`,
				{ msgtype: 'm.text', body: 'yes' }
			);
			expect(await r.nextSaying('Heard:', heard)).toBe('Heard: yes');
			expect(r.h.apisix.contracts.calls).toHaveLength(0);
			// Neither counted as my next message: my own yes still answers the question
			const found = r.saying('Found:').length;
			await r.client.sendText(r.room, 'yes');
			expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/boards/items');
		} finally {
			await bobClient.stop();
		}
	});
});
