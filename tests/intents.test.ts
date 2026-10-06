import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import type { ChatRequest } from './helpers/fake-apisix.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The SDK acts as each user through an intent it caches, an hour by default. An assistant runs for
// weeks, and its encryption, set up once in its intent, must stay the one that answers.
describe('an assistant that has been running for over an hour', () => {
	let h: MatrixTestHarness;
	const clients: E2eeClient[] = [];

	// The checks of the device an assistant speaks from: every setup of its encryption makes them
	function deviceChecksOf(userId: string): number {
		return h.apisix.matrixCalls.filter((call) => {
			const target = new URL(call.path, 'http://synapse');
			return (
				target.pathname === '/_matrix/client/v3/account/whoami' &&
				target.searchParams.get('user_id') === userId
			);
		}).length;
	}

	beforeAll(async () => {
		h = await startMatrixHarness();
		h.apisix.llm.script = (request: ChatRequest) => ({
			content: `echo: ${request.messages.at(-1)?.content ?? ''}`
		});
	}, 240_000);
	afterAll(async () => {
		for (const client of clients) await client.stop();
		if (h !== undefined) await h.close();
	});

	it('answers with the encryption it set up, without setting it up again', async () => {
		const owner = await h.synapse.registerUser('lena');
		const client = await startE2eeClient(h.synapse.url, owner);
		clients.push(client);
		const created = await h.api.post<{ roomId: string }>('lena@test.local', '/v1/assistants', {
			name: 'Uma'
		});
		expect(created.status).toBe(201);
		const room = created.body.roomId;
		for (let i = 0; i < 40; i += 1) {
			const invites = await h.synapse.pendingInvites(owner);
			if (invites.some((inv) => inv.roomId === room)) break;
			await sleep(250);
		}
		await client.joinRoom(room);
		const assistantId = '@twake-space-assistant-lena:test.local';
		await client.waitForMessage(room, assistantId, (t) => t.includes('Uma'));
		await client.sendText(room, 'hello');
		expect(await client.waitForMessage(room, assistantId, (t) => t === 'echo: hello')).toBe(
			'echo: hello'
		);
		const checks = deviceChecksOf(assistantId);
		const listeners = h.role.appservice.listenerCount('room.event');
		// An hour and a minute later, on the clock the SDK ages its intents by
		const now = performance.now.bind(performance);
		const clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + 61 * 60_000);
		try {
			await client.sendText(room, 'an hour later');
			expect(
				await client.waitForMessage(room, assistantId, (t) => t === 'echo: an hour later')
			).toBe('echo: an hour later');
		} finally {
			clock.mockRestore();
		}
		// No second setup, and no second encryption machine kept alive by the rooms' events
		expect({
			checks: deviceChecksOf(assistantId),
			listeners: h.role.appservice.listenerCount('room.event')
		}).toEqual({ checks, listeners });
	});
});
