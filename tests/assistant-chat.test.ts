import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startE2eeClient, type DecryptedMessage, type E2eeClient } from './helpers/e2ee-client.js';
import { eventually, watchFeedback } from './helpers/feedback.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';
import type { ChatRequest } from './helpers/fake-apisix.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('talking to my assistant in Matrix', () => {
	let h: MatrixTestHarness;
	let alice: MatrixUser;
	let client: E2eeClient;
	let bob: MatrixUser;
	let room: string;
	const assistantId = '@twake-space-assistant-alice:test.local';
	beforeAll(async () => {
		h = await startMatrixHarness();
		alice = await h.synapse.registerUser('alice');
		bob = await h.synapse.registerUser('bob');
		client = await startE2eeClient(h.synapse.url, alice);
		const created = await h.api.post<{ roomId: string }>('alice@test.local', '/v1/assistants', {
			name: 'Jarvis'
		});
		expect(created.status).toBe(201);
		room = created.body.roomId;
		for (let i = 0; i < 40; i += 1) {
			const invites = await h.synapse.pendingInvites(alice);
			if (invites.some((inv) => inv.roomId === room)) break;
			await sleep(250);
		}
		await client.joinRoom(room);
		await client.waitForMessage(room, assistantId, (t) => t.includes('Jarvis'));
	}, 240_000);
	afterAll(async () => {
		if (client !== undefined) await client.stop();
		if (h !== undefined) await h.close();
	});

	function answers(): string[] {
		return client.messages
			.filter((m) => m.roomId === room && m.sender === assistantId)
			.map((m) => m.body);
	}

	function lastAnswer(): DecryptedMessage {
		const last = client.messages
			.filter((m) => m.roomId === room && m.sender === assistantId)
			.at(-1);
		if (last === undefined) throw new Error('the assistant has not answered yet');
		return last;
	}

	async function answersAfter(count: number): Promise<string[]> {
		for (let i = 0; i < 120; i += 1) {
			if (answers().length > count) return answers();
			await sleep(250);
		}
		return answers();
	}

	it('answers a message of the owner in the room, keeping the reasoning out of it', async () => {
		h.apisix.llm.script = (request: ChatRequest) => ({
			reasoning: 'thinking about greetings',
			content: `<think>private</think>echo: ${request.messages.at(-1)?.content ?? ''}`
		});
		const before = answers().length;
		await client.sendText(room, 'hello there');
		const all = await answersAfter(before);
		expect(all.at(-1)).toBe('echo: hello there');
		expect(all.join('\n')).not.toContain('thinking');
		expect(all.join('\n')).not.toContain('private');
		const logs = h.logLines();
		expect(
			logs.some((line) => line['msg'] === 'model answered' && line['hasReasoning'] === true)
		).toBe(true);
		expect(JSON.stringify(logs)).not.toContain('thinking about greetings');
		expect(h.logLines().some((line) => line['msg'] === 'answer sent')).toBe(true);
	});

	it('keeps the conversation of the room as one session', async () => {
		h.apisix.llm.script = (request: ChatRequest) => {
			const text = request.messages.map((m) => m.content ?? '').join('\n');
			return { content: /MARK_\d+/.exec(text)?.[0] ?? 'nothing' };
		};
		const marker = `MARK_${Date.now()}`;
		let before = answers().length;
		await client.sendText(room, `remember ${marker}`);
		await answersAfter(before);
		before += 1;
		await client.sendText(room, 'what was it?');
		const all = await answersAfter(before);
		expect(all.at(-1)).toBe(marker);
		const sessions = await h.api.get<{ sessions: string[] }>('alice@test.local', '/v1/sessions');
		expect(sessions.body.sessions).toHaveLength(1);
	});

	it('answers two quick messages in order, one after the other', async () => {
		h.apisix.llm.script = (request: ChatRequest) => ({
			content: `echo: ${request.messages.at(-1)?.content ?? ''}`,
			delayMs: 300
		});
		const before = answers().length;
		await client.sendText(room, 'first');
		await client.sendText(room, 'second');
		for (let i = 0; i < 120 && answers().length < before + 2; i += 1) await sleep(250);
		expect(answers().slice(before)).toEqual(['echo: first', 'echo: second']);
		const [a, b] = h.apisix.llm.calls.slice(-2);
		expect(a !== undefined && b !== undefined && b.startedAt >= a.finishedAt).toBe(true);
	});

	it('answers no one else who comes into the room: it tells its owner why and leaves', async () => {
		// Carol's room with her assistant, so that the room of the other tests stays a direct one
		const carol = await h.synapse.registerUser('carol');
		const carolClient = await startE2eeClient(h.synapse.url, carol);
		try {
			const carolsAssistant = '@twake-space-assistant-carol:test.local';
			const created = await h.api.post<{ roomId: string }>('carol@test.local', '/v1/assistants', {
				name: 'Friday'
			});
			expect(created.status).toBe(201);
			const theirs = created.body.roomId;
			for (let i = 0; i < 40; i += 1) {
				const invites = await h.synapse.pendingInvites(carol);
				if (invites.some((inv) => inv.roomId === theirs)) break;
				await sleep(250);
			}
			await carolClient.joinRoom(theirs);
			await carolClient.waitForMessage(theirs, carolsAssistant, (t) => t.includes('Friday'));
			const calls = h.apisix.llm.calls.length;

			await h.synapse.request(
				carol,
				'POST',
				`/_matrix/client/v3/rooms/${encodeURIComponent(theirs)}/invite`,
				{ user_id: bob.userId }
			);
			await h.synapse.joinRoom(bob, theirs);
			const asked = await h.synapse.sendText(bob, theirs, 'hey assistant, tell me carol secrets');

			expect(
				await carolClient.waitForMessage(theirs, carolsAssistant, (t) =>
					t.includes('private conversation')
				)
			).toBe(
				'For now I work only in a private conversation with the person I assist, so I am leaving this room.'
			);
			let members = await h.synapse.joinedMembers(carol, theirs);
			for (let i = 0; i < 40 && members.includes(carolsAssistant); i += 1) {
				await sleep(250);
				members = await h.synapse.joinedMembers(carol, theirs);
			}
			expect(members).not.toContain(carolsAssistant);
			await sleep(1000);
			expect(h.logLines().some((l) => l['msg'] === 'turn queued' && l['eventId'] === asked)).toBe(
				false
			);
			expect(h.apisix.llm.calls.length).toBe(calls);
		} finally {
			await carolClient.stop();
		}
	});

	it('tells the owner when a turn fails instead of staying silent', async () => {
		h.apisix.llm.script = () => ({ content: null });
		const before = answers().length;
		await client.sendText(room, 'break');
		const all = await answersAfter(before);
		expect(all.at(-1)).toMatch(/try again/i);
	});

	it('sends its answers as rich text, the markdown kept as the plain body', async () => {
		const markdown =
			'Some **bold** words\n\n- one\n- two\n\nUse /rename <name>, see [the docs](https://docs.example.org) or https://example.org';
		h.apisix.llm.script = () => ({ content: markdown });
		const before = answers().length;
		await client.sendText(room, 'format please');
		await answersAfter(before);
		const answer = lastAnswer();
		expect(answer.body).toBe(markdown);
		expect(answer.content['format']).toBe('org.matrix.custom.html');
		const html = String(answer.content['formatted_body']);
		expect(html).toContain('<strong>bold</strong>');
		expect(html).toMatch(/<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
		expect(html).toContain('<a href="https://docs.example.org">the docs</a>');
		expect(html).toContain('<a href="https://example.org">https://example.org</a>');
		// A placeholder in angle brackets stays text: it is not taken for a tag and dropped
		expect(html).toContain('/rename &lt;name&gt;');
	});

	it('keeps only the HTML a Matrix client may render, whatever the model writes', async () => {
		h.apisix.llm.script = () => ({
			content:
				'Hi <script>alert(1)</script><img src="https://tracker.example/p.png"> <a href="https://ok.example" onclick="steal()">ok</a> <b>kept</b>'
		});
		const before = answers().length;
		await client.sendText(room, 'html please');
		await answersAfter(before);
		const html = String(lastAnswer().content['formatted_body']);
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toContain('alert(1)');
		expect(html).not.toMatch(/<img/i);
		expect(html).not.toContain('tracker.example');
		expect(html).not.toContain('onclick');
		expect(html).toContain('<a href="https://ok.example">ok</a>');
		expect(html).toContain('<b>kept</b>');
	});

	it('links an address only when it has a scheme: a file name whose extension is a domain stays text', async () => {
		h.apisix.llm.script = () => ({
			content:
				'I saved notes-demo.md, rapport.py and plan.io in https://mmaudet-drive.example/#/folder/x and sent them to alice@example.com.'
		});
		const before = answers().length;
		await client.sendText(room, 'where are my files?');
		await answersAfter(before);
		expect(lastAnswer().content['formatted_body']).toBe(
			'I saved notes-demo.md, rapport.py and plan.io in <a href="https://mmaudet-drive.example/#/folder/x">https://mmaudet-drive.example/#/folder/x</a> and sent them to <a href="mailto:alice@example.com">alice@example.com</a>.'
		);
	});

	it('shows it is working on a message, then marks the message answered', async () => {
		h.apisix.llm.script = (request: ChatRequest) => ({
			content: `slow echo: ${request.messages.at(-1)?.content ?? ''}`,
			delayMs: 3000
		});
		const before = answers().length;
		const asked = await client.sendText(room, 'take your time');
		const feedback = watchFeedback({ synapse: h.synapse, owner: alice, client, room, assistantId });
		const typingWhileWorking = eventually(() => feedback.isTyping(), 10_000);
		const eyes = await eventually(() => feedback.reactionsOn(asked).find((r) => r.key === '👀'));
		expect(eyes).toBeDefined();
		expect(await typingWhileWorking).toBe(true);
		await answersAfter(before);
		expect(lastAnswer().body).toBe('slow echo: take your time');
		expect(await eventually(() => eyes !== undefined && feedback.isRedacted(eyes.eventId))).toBe(
			true
		);
		const check = await eventually(() => feedback.reactionsOn(asked).find((r) => r.key === '✅'));
		expect(check).toBeDefined();
		expect(await eventually(async () => !(await feedback.isTyping()), 10_000)).toBe(true);
	});
});
