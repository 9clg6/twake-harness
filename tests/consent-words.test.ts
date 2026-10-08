import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
	modelFor,
	modelUsing,
	QUESTION_CONTENT_KEY,
	readCatalog,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';

const DOMAINS = [
	'mail',
	'drive',
	'tasks',
	'notes',
	'photos',
	'wiki',
	'contacts',
	'boards',
	'sheets'
];

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
		// Once run, the call keeps nothing of what it sent
		expect(await r.callsTo('mail')).toEqual([{ status: 'approved', arguments: null }]);
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

	it('asks me to answer in words, with no buttons under its question', async () => {
		r.h.apisix.llm.script = modelUsing('search_notes', { q: 'budget' });
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Search my notes for the budget');
		const question = await r.nextQuestion(seen);
		expect(r.questions().at(-1)?.body).toBe(
			[
				'This is the first time I need to read your data in notes. Do you allow it? I would start with this:',
				JSON.stringify({ q: 'budget' }, null, 2),
				'Answer yes or no in your next message.'
			].join('\n\n')
		);
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'yes');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/notes/items');
		// Twake Chat sends a tap on a reaction in the clear, which answers nothing: the assistant put
		// no reaction under its question, which my client would have read before the answer
		expect(await r.client.waitForReactions(r.room, question, r.assistantId, 1, 0)).toEqual([]);
	});

	it('tells my client which request its question is and until when, in words left unchanged', async () => {
		r.h.apisix.llm.script = modelUsing('search_sheets', { q: 'budget' });
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Find the budget in my sheets');
		const asked = await r.nextQuestion(seen);
		const question = r.questions().find((m) => m.eventId === asked);
		expect(question?.body).toBe(
			[
				'This is the first time I need to read your data in sheets. Do you allow it? I would start with this:',
				JSON.stringify({ q: 'budget' }, null, 2),
				'Answer yes or no in your next message.'
			].join('\n\n')
		);
		await r.requestAskedIn(asked, 'sheets');
		// My yes in words answers it as before
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'oui');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/sheets/items');
		// Only its questions are marked: not its welcome, nor an answer or a notice
		const marked = r.client.messages.filter(
			(m) => m.roomId === r.room && m.sender === r.assistantId && QUESTION_CONTENT_KEY in m.content
		);
		expect(marked.map((m) => m.eventId)).toEqual(r.questions().map((m) => m.eventId));
	});

	it('takes anything else I write for a message, after which only a reaction answers', async () => {
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
		// The question is still open: a ✅ from my client, which encrypts it, answers it
		const found = r.saying('Found:').length;
		await r.client.react(r.room, question, '✅');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/photos/items');
	});

	it('lets a newer question replace the open one, and tells me when I answer the old one', async () => {
		r.h.apisix.llm.script = modelFor({
			'Find the minutes in my wiki': { tool: 'search_wiki', args: { q: 'minutes' } },
			'Look in my contacts instead': { tool: 'search_contacts', args: { q: 'minutes' } }
		});
		let seen = r.questions().length;
		await r.client.sendText(r.room, 'Find the minutes in my wiki');
		const older = await r.nextQuestion(seen);
		seen = r.questions().length;
		await r.client.sendText(r.room, 'Look in my contacts instead');
		await r.nextQuestion(seen);
		const notices = r.saying('A newer request').length;
		await r.client.react(r.room, older, '✅');
		expect(await r.nextSaying('A newer request', notices)).toBe(
			'A newer request replaced this one, so I did nothing. Answer the latest one.'
		);
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
		// My yes, in any language the harness speaks, answers the newer one
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'Oui');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/contacts/items');
		expect(r.h.apisix.contracts.calls.map((c) => c.path)).toEqual(['/contracts/v1/contacts/items']);
		expect(await r.callsTo('wiki')).toEqual([{ status: 'superseded', arguments: null }]);
	});

	// No one else can answer for me: someone else coming into the room makes the assistant leave it
	it('ignores a yes sent unencrypted from my account', async () => {
		r.h.apisix.llm.script = modelFor({
			'Show my boards': { tool: 'search_boards', args: { q: 'all' } }
		});
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Show my boards');
		await r.nextQuestion(seen);
		// A yes written in my name without encryption, as a component on the server could, starts
		// nothing and answers nothing: the harness only logs it
		const heard = r.saying('Heard:').length;
		const plain = await r.h.synapse.sendText(r.alice, r.room, 'yes');
		expect((await r.h.decisionOn(plain))?.['msg']).toBe('assistant ignored an unencrypted message');
		expect(r.h.apisix.contracts.calls).toHaveLength(0);
		// It did not count as my next message: my own yes still answers the question
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'yes');
		expect(await r.nextSaying('Found:', found)).toContain('/contracts/v1/boards/items');
		expect(r.saying('Heard:')).toHaveLength(heard);
	});
});
