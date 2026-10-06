import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listMemory } from '../src/memory/repository.js';
import { withPrincipal } from '../src/db/client.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import type { ChatRequest } from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const CATALOG = {
	openapi: '3.0.3',
	paths: {
		'/v1/usage/summary': {
			get: { operationId: 'usage.summary.read.v1', summary: 'Aggregated usage of the organization' }
		}
	}
};

describe('the organization agent', () => {
	let h: MatrixTestHarness;
	let alice: MatrixUser;
	let aliceClient: E2eeClient;
	let bob: MatrixUser;
	let bobClient: E2eeClient;
	let room: string;
	const orgId = '@twake-space-assistant-org:test.local';
	beforeAll(async () => {
		h = await startMatrixHarness({
			env: {
				ORG_AGENT_ENABLED: 'true',
				ORG_AGENT_NAME: 'Twake Space',
				ORG_AGENT_PERSONA: 'You are the organization agent of Twake Space.',
				ORG_AGENT_MEMBERS: '@alice:test.local, @carol:test.local'
			}
		});
		h.apisix.contracts.spec = CATALOG;
		for (const app of h.apps) expect(await app.agent.contracts.load()).toBe(1);
		h.apisix.contracts.handler = () => ({ status: 200, body: { turns: 42, users: 7 } });
		alice = await h.synapse.registerUser('alice');
		bob = await h.synapse.registerUser('bob');
		aliceClient = await startE2eeClient(h.synapse.url, alice);
		bobClient = await startE2eeClient(h.synapse.url, bob);
		h.apisix.llm.script = (request: ChatRequest) => {
			const last = request.messages.at(-1);
			if (last?.role === 'tool') {
				const data = JSON.parse(last.content ?? '{}') as { body?: { turns?: number } };
				return {
					content: data.body?.turns === undefined ? 'Noted.' : `Usage: ${data.body.turns} turns`
				};
			}
			const text = request.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
			if (text.includes('usage')) {
				return {
					toolCalls: [
						{
							id: 'call_usage',
							type: 'function',
							function: { name: 'usage_summary_read_v1', arguments: '{}' }
						}
					]
				};
			}
			if (text.includes('remember')) {
				return {
					toolCalls: [
						{
							id: 'call_memory',
							type: 'function',
							function: {
								name: 'memory',
								arguments: JSON.stringify({
									action: 'add',
									target: 'memory',
									content: 'Budget reviews happen on Fridays'
								})
							}
						}
					]
				};
			}
			return { content: `echo: ${text}` };
		};
	}, 240_000);
	afterAll(async () => {
		if (aliceClient !== undefined) await aliceClient.stop();
		if (bobClient !== undefined) await bobClient.stop();
		if (h !== undefined) await h.close();
	});

	it('greets a member who opens a direct message, and answers with the usage read under the harness key alone', async () => {
		room = await aliceClient.createDirectRoom(orgId);
		const greeting = await aliceClient.waitForMessage(room, orgId, (t) =>
			t.includes('Twake Space')
		);
		expect(greeting).toContain('organization agent');
		await aliceClient.sendText(room, 'what is our usage?');
		const answer = await aliceClient.waitForMessage(room, orgId, (t) => t.startsWith('Usage:'));
		expect(answer).toBe('Usage: 42 turns');
		const call = h.apisix.contracts.calls.find((c) => c.path === '/v1/usage/summary');
		expect(call?.headers['apikey']).toBe(h.apisix.consumerKey);
		expect(call?.headers['x-twake-on-behalf-of']).toBeUndefined();
		const prompt = h.apisix.llm.calls.at(-1)?.request.messages[0]?.content ?? '';
		expect(prompt).toContain('You are the organization agent of Twake Space.');
		const heard = h.apisix.llm.calls.at(-1)?.request.messages.find((m) => m.role === 'user');
		expect(heard?.content).toContain('[@alice:test.local]');
		expect(
			h
				.logLines()
				.some((l) => l['msg'] === 'turn queued' && l['owner'] === 'org' && l['roomId'] === room)
		).toBe(true);
	});

	it('ignores anyone who is not a member', async () => {
		const bobRoom = await bobClient.createDirectRoom(orgId);
		await sleep(3000);
		expect(await h.synapse.joinedMembers(bob, bobRoom)).not.toContain(orgId);
		expect(
			h
				.logLines()
				.some(
					(l) => l['msg'] === 'organization agent ignored an invite' && l['sender'] === bob.userId
				)
		).toBe(true);
		expect(bobClient.messages.filter((m) => m.sender === orgId)).toHaveLength(0);
	});

	it('keeps its memory in the organization scope, out of reach of the members and their assistants', async () => {
		await aliceClient.sendText(room, 'remember that budget reviews happen on Fridays');
		expect(await aliceClient.waitForMessage(room, orgId, (t) => t === 'Noted.')).toBe('Noted.');
		const organization = await withPrincipal(h.db, { id: 'org' }, (tx) => listMemory(tx, 'org'));
		expect(organization.memory.some((e) => e.includes('Fridays'))).toBe(true);
		const mine = await h.api.get<{ memory: { content: string }[] }>(
			'alice@test.local',
			'/v1/memory'
		);
		expect(mine.status).toBe(200);
		expect(JSON.stringify(mine.body)).not.toContain('Fridays');
		// No token carries the organization principal
		expect((await h.api.get('org', '/v1/me')).status).toBe(401);
	});
});
