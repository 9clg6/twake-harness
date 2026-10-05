import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';
import type { MatrixUser } from './helpers/synapse.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('the matrix role as an application service', () => {
	let h: MatrixTestHarness;
	let alice: MatrixUser;
	beforeAll(async () => {
		h = await startMatrixHarness();
		alice = await h.synapse.registerUser('alice');
	}, 180_000);
	afterAll(async () => {
		if (h !== undefined) await h.close();
	});

	it('answers the ping of the homeserver', async () => {
		const res = await h.synapse.request(
			{ userId: '', accessToken: 'as-token-test' },
			'POST',
			`/_matrix/client/v1/appservice/${h.config.matrix.appserviceId}/ping`,
			{ transaction_id: 'ping-1' }
		);
		expect(res.status).toBe(200);
	});

	it('refuses a transaction that does not carry the homeserver token', async () => {
		const res = await fetch(`http://127.0.0.1:${h.port}/_matrix/app/v1/transactions/forged-1`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
			body: JSON.stringify({ events: [] })
		});
		expect(res.status).toBeGreaterThanOrEqual(401);
		expect(res.status).toBeLessThan(500);
	});

	it('joins a direct message with the creator, greets once, and answers help', async () => {
		const roomId = await h.synapse.createDirectRoom(alice, h.role.creatorUserId);
		const greeting = await h.synapse.waitForMessage(alice, roomId, h.role.creatorUserId, (t) =>
			t.includes('/newbot')
		);
		expect(greeting).toContain('/delete');
		await sleep(1000);
		expect(await h.synapse.messagesFrom(alice, roomId, h.role.creatorUserId)).toHaveLength(1);
		await h.synapse.sendText(alice, roomId, 'help');
		let replies: string[] = [];
		for (let i = 0; i < 60 && replies.length < 2; i += 1) {
			await sleep(250);
			replies = await h.synapse.messagesFrom(alice, roomId, h.role.creatorUserId);
		}
		expect(replies).toHaveLength(2);
		expect(replies[1]).toContain('/newbot');
		expect(
			h.logLines().some((line) => line['msg'] === 'creator command' && line['command'] === '/help')
		).toBe(true);
	});

	it('processes a transaction delivered twice only once', async () => {
		const roomId = await h.synapse.createDirectRoom(alice, h.role.creatorUserId);
		await h.synapse.waitForMessage(alice, roomId, h.role.creatorUserId, (t) =>
			t.includes('/newbot')
		);
		const before = (await h.synapse.messagesFrom(alice, roomId, h.role.creatorUserId)).length;
		const transaction = {
			events: [
				{
					type: 'm.room.message',
					sender: alice.userId,
					room_id: roomId,
					event_id: '$replayed',
					origin_server_ts: Date.now(),
					content: { msgtype: 'm.text', body: 'help' }
				}
			]
		};
		for (let i = 0; i < 2; i += 1) {
			const res = await fetch(`http://127.0.0.1:${h.port}/_matrix/app/v1/transactions/replayed-1`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${h.hsToken}` },
				body: JSON.stringify(transaction)
			});
			expect(res.status).toBe(200);
		}
		let after = before;
		for (let i = 0; i < 60 && after <= before; i += 1) {
			await sleep(250);
			after = (await h.synapse.messagesFrom(alice, roomId, h.role.creatorUserId)).length;
		}
		await sleep(1500);
		after = (await h.synapse.messagesFrom(alice, roomId, h.role.creatorUserId)).length;
		expect(after - before).toBe(1);
	});
});
