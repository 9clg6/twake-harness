import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestHarness, type TestHarness } from './helpers/app.js';
import {
	CALENDAR_CATALOG,
	echoScript,
	type ScriptedReply,
	type ToolCall
} from './helpers/fake-apisix.js';

interface ChatReply {
	readonly answer?: string;
	readonly session_id?: string;
	readonly pending_call?: { readonly id: string };
}

async function chat(
	h: TestHarness,
	message: string,
	sessionId?: string
): Promise<{ status: number; body: ChatReply }> {
	const res = await h.app.inject({
		method: 'POST',
		url: '/v1/chat',
		headers: { authorization: `Bearer ${await h.issuer.mint({ sub: 'alice' })}` },
		payload: { message, ...(sessionId === undefined ? {} : { session_id: sessionId }) }
	});
	return { status: res.statusCode, body: res.json() };
}

function call(id: string, name: string, args: unknown = {}): ToolCall {
	return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const PLAN = call('plan_1', 'plan', {
	steps: [
		{ what: 'Read the consents', tool: 'consents_list' },
		{ what: 'Read the skills', tool: 'scoped_skills_list' }
	]
});
const READ_CONSENTS: ScriptedReply = { toolCalls: [call('consents_1', 'consents_list')] };
const READ_SKILLS: ScriptedReply = { toolCalls: [call('skills_1', 'scoped_skills_list')] };

describe('a turn whose model plans its request in steps', () => {
	let h: TestHarness;
	beforeAll(async () => {
		// Many turns of one owner in a row: admission is the subject of its own suite
		h = await startTestHarness({ env: { ADMISSION_USER_PER_MINUTE: '100' } });
	});
	afterAll(async () => {
		await h.close();
	});
	beforeEach(() => {
		h.apisix.llm.calls.length = 0;
		h.apisix.llm.script = echoScript;
	});

	// The system prompt of a model call, where the harness tells the model where its plan stands
	const systemOf = (index: number): string =>
		h.apisix.llm.calls[index]?.request.messages[0]?.content ?? '';

	it('marks each step done from the result of its call, and adds nothing to the answer', async () => {
		const replies: ScriptedReply[] = [{ toolCalls: [PLAN] }, READ_CONSENTS, READ_SKILLS];
		h.apisix.llm.script = (_request, index) => replies[index] ?? { content: 'Both read.' };
		const { status, body } = await chat(h, 'Read my consents and my skills');
		expect(status).toBe(200);
		expect(body.answer).toBe('Both read.');
		expect(h.apisix.llm.calls).toHaveLength(4);
		// Until it plans, the model is told when to: once it did, where its plan stands
		expect(systemOf(0)).toMatch(/## Before you act/);
		expect(systemOf(0)).not.toMatch(/## Plan\n/);
		expect(systemOf(1)).not.toMatch(/## Before you act/);
		expect(systemOf(1)).toMatch(/1\. \[to do\] Read the consents \(consents_list\)/);
		expect(systemOf(2)).toMatch(/1\. \[done\] Read the consents/);
		expect(systemOf(2)).toMatch(/2\. \[to do\] Read the skills/);
		expect(systemOf(3)).toMatch(/2\. \[done\] Read the skills/);
		expect(systemOf(3)).toMatch(/Every step is done/);
	});

	it('sends a model that answers before its last step back to it, once', async () => {
		const replies: ScriptedReply[] = [
			{ toolCalls: [PLAN] },
			READ_CONSENTS,
			{ content: 'All done.' },
			READ_SKILLS
		];
		h.apisix.llm.script = (_request, index) => replies[index] ?? { content: 'Now both read.' };
		const { body } = await chat(h, 'Read my consents and my skills');
		expect(body.answer).toBe('Now both read.');
		expect(h.apisix.llm.calls).toHaveLength(5);
		expect(systemOf(3)).toMatch(/You answered while steps were still to do/);
		// The answer the harness sent back is not part of the conversation
		const sent = h.apisix.llm.calls[3]?.request.messages ?? [];
		expect(sent.some((m) => m.content === 'All done.')).toBe(false);
	});

	it('tells the owner itself which steps a model left undone twice', async () => {
		const replies: ScriptedReply[] = [{ toolCalls: [PLAN] }, READ_CONSENTS];
		h.apisix.llm.script = (_request, index) => replies[index] ?? { content: 'All done.' };
		const { body } = await chat(h, 'Read my consents and my skills');
		expect(h.apisix.llm.calls).toHaveLength(4);
		expect(body.answer).toBe('All done.\n\nNot done, of what I had planned:\n- Read the skills');
		// The conversation keeps the answer as the owner read it
		h.apisix.llm.script = echoScript;
		await chat(h, 'Thanks', body.session_id);
		const kept = h.apisix.llm.calls[4]?.request.messages ?? [];
		expect(kept.at(-2)).toMatchObject({ role: 'assistant', content: body.answer });
	});

	it('does not count a step whose call failed', async () => {
		const replies: ScriptedReply[] = [
			{ toolCalls: [PLAN] },
			READ_CONSENTS,
			{ toolCalls: [call('skills_1', 'scoped_skills_list', { owner: 'bob' })] }
		];
		h.apisix.llm.script = (_request, index) => replies[index] ?? { content: 'Done.' };
		const { body } = await chat(h, 'Read my consents and my skills');
		expect(body.answer).toMatch(/Not done, of what I had planned:\n- Read the skills$/);
	});

	it('refuses a plan that names a tool the turn does not offer', async () => {
		const bad = call('plan_1', 'plan', {
			steps: [
				{ what: 'Read the consents', tool: 'consents_list' },
				{ what: 'Launch', tool: 'rocket_launch' }
			]
		});
		h.apisix.llm.script = (_request, index) =>
			index === 0 ? { toolCalls: [bad] } : { content: 'No plan.' };
		const { body } = await chat(h, 'Read and launch');
		expect(body.answer).toBe('No plan.');
		const result = h.apisix.llm.calls[1]?.request.messages.find((m) => m.role === 'tool');
		expect(result?.content).toMatch(/unknown tool: rocket_launch/);
		expect(systemOf(1)).not.toMatch(/## Plan/);
	});

	it('makes a step of a write the model did not plan, and checks it like any other', async () => {
		const accept: ScriptedReply = {
			toolCalls: [call('accept_1', 'accept_invitation', { event_id: 'evt-9' })]
		};
		h.apisix.contracts.spec = CALENDAR_CATALOG;
		for (const app of h.apps) await app.agent.contracts.load();
		const headers = { authorization: `Bearer ${await h.issuer.mint({ sub: 'erin' })}` };
		const post = async (url: string, payload: unknown): Promise<ChatReply> =>
			(await h.app.inject({ method: 'POST', url, headers, payload: payload as object })).json();
		// The first write waits for its owner, whose yes allows the next ones
		h.apisix.llm.script = (_request, index) => (index === 0 ? accept : { content: 'Accepted.' });
		const asked = await post('/v1/chat', { message: 'Accept the invitation evt-9' });
		const resumed = await post(`/v1/pending-calls/${asked.pending_call?.id}/approve`, {});
		// The harness says the write done only once its contract answered with a success
		expect(resumed.answer).toMatch(/^Accepted\.\n\nDone:\n- Accept an invitation/);
		// The contract then fails the same write: the model says it is done, the harness says it is not
		h.apisix.llm.calls.length = 0;
		h.apisix.contracts.handler = () => ({ status: 500, body: { error: 'down' } });
		const failed = await post('/v1/chat', { message: 'Accept the invitation evt-9 again' });
		h.apisix.contracts.handler = () => ({ status: 200, body: { ok: true } });
		expect(systemOf(1)).toMatch(/1\. \[to do\] Accept an invitation.* \(accept_invitation\)/);
		expect(failed.answer).toMatch(
			/^Accepted\.\n\nNot done, of what I had planned:\n- Accept an invitation/
		);
	});

	it('holds the turn a yes of its owner resumes to the plan it had', async () => {
		const planned = call('plan_1', 'plan', {
			steps: [
				{ what: 'Accept the invitation', tool: 'accept_invitation' },
				{ what: 'Read the skills', tool: 'scoped_skills_list' }
			]
		});
		const replies: ScriptedReply[] = [
			{ toolCalls: [planned] },
			{ toolCalls: [call('accept_1', 'accept_invitation', { event_id: 'evt-9' })] }
		];
		h.apisix.contracts.spec = CALENDAR_CATALOG;
		for (const app of h.apps) await app.agent.contracts.load();
		h.apisix.llm.script = (_request, index) => replies[index] ?? { content: 'Accepted.' };
		const token = await h.issuer.mint({ sub: 'carol' });
		const asked = await h.app.inject({
			method: 'POST',
			url: '/v1/chat',
			headers: { authorization: `Bearer ${token}` },
			payload: { message: 'Accept the invitation evt-9, then read my skills' }
		});
		const pending: { pending_call?: { id: string } } = asked.json();
		expect(pending.pending_call).toBeDefined();
		const resumed = await h.app.inject({
			method: 'POST',
			url: `/v1/pending-calls/${pending.pending_call?.id}/approve`,
			headers: { authorization: `Bearer ${token}` },
			payload: {}
		});
		expect(resumed.statusCode).toBe(200);
		// The resumed walk reads the plan back: the call its owner allowed is done, the other is not,
		// so the answer the model gives at once is sent back, then reported
		expect(systemOf(2)).toMatch(/1\. \[done\] Accept the invitation/);
		expect(systemOf(2)).toMatch(/2\. \[to do\] Read the skills/);
		expect(systemOf(3)).toMatch(/You answered while steps were still to do/);
		const body: ChatReply = resumed.json();
		expect(body.answer).toBe(
			'Accepted.\n\nDone:\n- Accept the invitation (event_id: evt-9)\n\nNot done, of what I had planned:\n- Read the skills'
		);
	});

	it('keeps out of the answer a call the model wrote in its text', async () => {
		h.apisix.llm.script = () => ({
			content:
				'I can help with your calendar.\n\n<tools_call>\n{"name": "scoped_skills_list", "arguments": {}}\n</tools_call>'
		});
		const { body } = await chat(h, 'Hello');
		expect(body.answer).toBe('I can help with your calendar.');
	});

	it('checks an answer sentence by sentence when the turn could act and did not', async () => {
		h.apisix.contracts.spec = CALENDAR_CATALOG;
		for (const app of h.apps) await app.agent.contracts.load();
		// The model says a meeting is scheduled, with no call; asked to check, a model names the sentence
		const said = 'The review was moved to Friday. Your meeting is scheduled for tomorrow.';
		h.apisix.llm.script = () => ({ content: said });
		h.apisix.llm.checks.length = 0;
		h.apisix.llm.checkScript = () => ({ content: '{"claims":[2]}' });
		const { body } = await chat(h, 'Put a meeting in my calendar tomorrow');
		// The sentence it named is taken out of what the owner reads, and the harness says why
		expect(body.answer).toBe(
			'The review was moved to Friday.\n\nNothing was done in your applications for this message.'
		);
		// The check reads the sentences apart, with what came before the answer, and has no tool
		expect(h.apisix.llm.checks).toHaveLength(1);
		const check = h.apisix.llm.checks[0]?.request;
		expect(check?.tools).toBeUndefined();
		expect(check?.messages[1]?.content).toMatch(/\[user\] Put a meeting in my calendar tomorrow/);
		expect(check?.messages[1]?.content).toMatch(
			/1\. The review was moved to Friday\.\n2\. Your meeting is scheduled for tomorrow\./
		);
	});

	it('leaves an answer as it is when the check names no sentence, or answers anything else', async () => {
		h.apisix.llm.script = () => ({ content: 'The review was moved to Friday.' });
		for (const checked of ['{"claims":[]}', 'I am not sure.']) {
			h.apisix.llm.checkScript = () => ({ content: checked });
			const { body } = await chat(h, 'What about the review?');
			expect(body.answer).toBe('The review was moved to Friday.');
		}
	});

	it('reads the events of the owner itself to check an answer against, asking them nothing', async () => {
		h.apisix.contracts.spec = {
			...CALENDAR_CATALOG,
			paths: {
				...CALENDAR_CATALOG.paths,
				'/contracts/v1/events': {
					get: { operationId: 'list_events', tags: ['events.read.v1'], parameters: [] }
				}
			}
		};
		for (const app of h.apps) await app.agent.contracts.load();
		h.apisix.contracts.calls.length = 0;
		h.apisix.contracts.handler = () => ({
			status: 200,
			body: { events: [{ title: 'Budget review', note: 'moved to Friday by Bob' }] }
		});
		h.apisix.llm.checks.length = 0;
		h.apisix.llm.checkScript = () => ({ content: '{"claims":[]}' });
		h.apisix.llm.script = () => ({ content: 'The budget review was moved to Friday.' });
		const { body } = await chat(h, 'Any news on the budget review meeting?');
		h.apisix.contracts.handler = () => ({ status: 200, body: { ok: true } });
		expect(body.answer).toBe('The budget review was moved to Friday.');
		expect(body.pending_call).toBeUndefined();
		expect(h.apisix.contracts.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			'GET /contracts/v1/events'
		]);
		expect(h.apisix.llm.checks[0]?.request.messages[1]?.content).toMatch(
			/\[result of list_events\].*moved to Friday by Bob/
		);
	});

	it('runs no write before the steps planned ahead of it', async () => {
		const planned = call('plan_1', 'plan', {
			steps: [
				{ what: 'Read the consents', tool: 'consents_list' },
				{ what: 'Accept the invitation', tool: 'accept_invitation' }
			]
		});
		const accept = call('accept_1', 'accept_invitation', { event_id: 'evt-9' });
		const replies: ScriptedReply[] = [
			{ toolCalls: [planned] },
			{ toolCalls: [accept] },
			READ_CONSENTS,
			{ toolCalls: [{ ...accept, id: 'accept_2' }] }
		];
		h.apisix.contracts.spec = CALENDAR_CATALOG;
		for (const app of h.apps) await app.agent.contracts.load();
		h.apisix.llm.script = (_request, index) => replies[index] ?? { content: 'Accepted.' };
		const res = await h.app.inject({
			method: 'POST',
			url: '/v1/chat',
			headers: { authorization: `Bearer ${await h.issuer.mint({ sub: 'frank' })}` },
			payload: { message: 'Read my consents, then accept the invitation evt-9' }
		});
		const body: ChatReply = res.json();
		// The write made too early did not run; made again after its read, it waits for its owner
		const refused = h.apisix.llm.calls[2]?.request.messages.at(-1);
		expect(refused?.content).toMatch(/step_order.*Read the consents/);
		expect(h.apisix.llm.calls).toHaveLength(4);
		expect(body.pending_call).toBeDefined();
	});

	it('leaves a turn without a plan as it was', async () => {
		const { body } = await chat(h, 'Bonjour');
		expect(body.answer).toBe('echo: Bonjour');
		expect(h.apisix.llm.calls).toHaveLength(1);
		const offered = JSON.stringify(h.apisix.llm.calls[0]?.request.tools);
		expect(offered).toMatch(/"name":"plan"/);
	});
});

describe('a deployment whose gateway serves a decision model to sort answers', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness({ env: { LLM_SORT_MODEL: 'jev', LLM_CHECK_MODEL: 'fast' } });
		h.apisix.contracts.spec = CALENDAR_CATALOG;
		for (const app of h.apps) await app.agent.contracts.load();
	});
	afterAll(async () => {
		await h.close();
	});

	it('sends at once an answer that has nothing to do with what it can do, unchecked', async () => {
		h.apisix.llm.sortProbability = 0.01;
		const { body } = await chat(h, 'Bonjour');
		expect(body.answer).toBe('echo: Bonjour');
		expect(h.apisix.llm.checks).toHaveLength(0);
		// The decision model is told the actions the catalog offers, and asked one typed question
		const sort = h.apisix.llm.sorts.at(-1)?.request;
		expect(sort?.model).toBe('jev');
		const asked = JSON.parse(sort?.messages[0]?.content ?? '{}') as {
			state: string;
			questions: { concerns: { type: string } };
		};
		expect(asked.state).toMatch(/accept_invitation: Accept an invitation/);
		expect(asked.state).toMatch(/User: Bonjour\nAssistant: echo: Bonjour/);
		expect(asked.questions.concerns.type).toBe('noul');
	});

	it('has a decision model tell what a message asks for, and holds the model to it', async () => {
		h.apisix.llm.sorts.length = 0;
		h.apisix.llm.calls.length = 0;
		h.apisix.llm.routeProbabilities = {
			read_freebusy: 0.9,
			accept_invitation: 0.8,
			read_event: 0.1
		};
		h.apisix.llm.script = () => ({ content: 'Sure.' });
		const { body } = await chat(h, 'Accept the invitation of Bob if I am free');
		h.apisix.llm.routeProbabilities = {};
		// The decision model is asked about each thing the catalog offers, before the model speaks
		const routed = JSON.parse(h.apisix.llm.sorts[0]?.request.messages[0]?.content ?? '{}') as {
			state: string;
			questions: Record<string, { type: string }>;
		};
		expect(Object.keys(routed.questions).sort()).toEqual([
			'accept_invitation',
			'read_event',
			'read_freebusy'
		]);
		expect(routed.state).toMatch(
			/User's last message to their assistant: Accept the invitation of Bob/
		);
		// What it named is the plan the model reads from its first call, the read before the write
		const system = h.apisix.llm.calls[0]?.request.messages[0]?.content ?? '';
		expect(system).toMatch(
			/1\. \[to do\] .* \(read_freebusy\)\n2\. \[to do\] .* \(accept_invitation\)/
		);
		expect(system).not.toMatch(/read_event\)/);
		// A model that does none of it is sent back once, then the owner reads what was not done
		expect(h.apisix.llm.calls).toHaveLength(2);
		expect(body.answer).toMatch(/^Sure\.\n\nNot done, of what I had planned:\n- .*\n- /);
	});

	it('leaves a message that asks for nothing it can do to the model, with no plan', async () => {
		h.apisix.llm.calls.length = 0;
		h.apisix.llm.sortProbability = 0.01;
		h.apisix.llm.script = echoScript;
		const { body } = await chat(h, 'Hello there');
		expect(body.answer).toBe('echo: Hello there');
		expect(h.apisix.llm.calls[0]?.request.messages[0]?.content).not.toMatch(/## Plan\n/);
	});

	it('holds a write to what the message asks for: refused, asked about, or run', async () => {
		const headers = { authorization: `Bearer ${await h.issuer.mint({ sub: 'gina' })}` };
		const post = async (url: string, payload: unknown): Promise<ChatReply> =>
			(await h.app.inject({ method: 'POST', url, headers, payload: payload as object })).json();
		const accept: ScriptedReply = {
			toolCalls: [call('accept_1', 'accept_invitation', { event_id: 'evt-9' })]
		};
		h.apisix.llm.sortProbability = 0.01;
		// The model makes the write, then answers once it reads what came of it
		h.apisix.llm.script = (request) =>
			request.messages.at(-1)?.name === 'accept_invitation' ? { content: 'Seen.' } : accept;
		const writes = (): number =>
			h.apisix.contracts.calls.filter((made) => made.method === 'POST').length;
		h.apisix.contracts.calls.length = 0;

		// A message that clearly does not ask for it: the write does not run, and nothing is asked
		h.apisix.llm.routeProbabilities = { accept_invitation: 0.05 };
		h.apisix.llm.calls.length = 0;
		const refused = await post('/v1/chat', { message: 'Nice weather today' });
		expect(refused.pending_call).toBeUndefined();
		expect(h.apisix.llm.calls[1]?.request.messages.at(-1)?.content).toMatch(/not_asked/);
		expect(writes()).toBe(0);

		// A message that asks for it: the first use waits for its owner, whose yes allows the next
		h.apisix.llm.routeProbabilities = { accept_invitation: 0.9 };
		const first = await post('/v1/chat', { message: 'Accept the invitation evt-9' });
		await post(`/v1/pending-calls/${first.pending_call?.id}/approve`, {});
		expect(writes()).toBe(1);
		const allowed = await post('/v1/chat', { message: 'Accept the invitation evt-9 again' });
		expect(allowed.pending_call).toBeUndefined();
		expect(writes()).toBe(2);

		// A message that may ask for it: the write waits for a yes, whatever was allowed before
		h.apisix.llm.routeProbabilities = { accept_invitation: 0.4 };
		const unsure = await post('/v1/chat', { message: 'That invitation, hm' });
		expect(unsure.pending_call).toBeDefined();
		expect(writes()).toBe(2);
		h.apisix.llm.routeProbabilities = {};
		h.apisix.llm.sortProbability = 1;
	});

	it('gives the model the tools of its lane, and no other of the applications', async () => {
		const offered = async (
			message: string,
			probabilities: Record<string, number>
		): Promise<string[]> => {
			h.apisix.llm.routeProbabilities = probabilities;
			h.apisix.llm.calls.length = 0;
			h.apisix.llm.script = () => ({ content: 'Fine.' });
			await chat(h, message);
			const tools = (h.apisix.llm.calls[0]?.request.tools ?? []) as {
				function: { name: string };
			}[];
			return tools
				.map((tool) => tool.function.name)
				.filter((name) =>
					['read_event', 'read_freebusy', 'accept_invitation', 'plan'].includes(name)
				)
				.sort();
		};
		h.apisix.llm.sortProbability = 0.01;
		// Nothing asked: it talks, with none of the applications' tools
		expect(await offered('Hello', {})).toEqual([]);
		// A read asked: it has that read, and no write
		expect(await offered('Am I free?', { read_freebusy: 0.9 })).toEqual(['read_freebusy']);
		// A write asked, with the read before it: it has both
		expect(
			await offered('Accept if I am free', { read_freebusy: 0.8, accept_invitation: 0.9 })
		).toEqual(['accept_invitation', 'read_freebusy']);
		// A write that may be asked: it has every tool, and never the plan, which is not its own
		expect(await offered('That invitation, hm', { accept_invitation: 0.4 })).toEqual([
			'accept_invitation',
			'read_event',
			'read_freebusy'
		]);
		h.apisix.llm.routeProbabilities = {};
		h.apisix.llm.sortProbability = 1;
	});

	it('runs no call to a tool its lane does not give, should the model make one', async () => {
		h.apisix.llm.sortProbability = 0.01;
		h.apisix.llm.routeProbabilities = { read_freebusy: 0.9 };
		h.apisix.llm.calls.length = 0;
		h.apisix.contracts.calls.length = 0;
		h.apisix.llm.script = (request) =>
			request.messages.at(-1)?.name === 'read_event'
				? { content: 'Seen.' }
				: { toolCalls: [call('read_1', 'read_event', { event_id: 'evt-9' })] };
		await chat(h, 'Am I free tomorrow?');
		expect(h.apisix.llm.calls[1]?.request.messages.at(-1)?.content).toMatch(/not_asked/);
		expect(h.apisix.contracts.calls).toHaveLength(0);
		h.apisix.llm.routeProbabilities = {};
		h.apisix.llm.sortProbability = 1;
	});

	it('has the other answers checked, by the model set for that', async () => {
		h.apisix.llm.sortProbability = 0.9;
		h.apisix.llm.checks.length = 0;
		h.apisix.llm.checkScript = () => ({ content: '{"claims":[1]}' });
		h.apisix.llm.script = () => ({ content: 'I accepted the invitation. Anything else?' });
		const { body } = await chat(h, 'Accept the invitation of Bob');
		expect(body.answer).toBe(
			'Anything else?\n\nNothing was done in your applications for this message.'
		);
		expect(h.apisix.llm.checks[0]?.request.model).toBe('fast');
	});
});

describe('a deployment that turns planning off', () => {
	let h: TestHarness;
	afterAll(async () => {
		await h.close();
	});

	it('offers the model no plan', async () => {
		h = await startTestHarness({ env: { TURN_PLANNING: 'false' } });
		await chat(h, 'Bonjour');
		expect(JSON.stringify(h.apisix.llm.calls[0]?.request.tools)).not.toMatch(/"name":"plan"/);
	});
});
