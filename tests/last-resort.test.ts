import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeRejection } from '../src/matrix/last-resort.js';
import { startE2eeClient, type E2eeClient } from './helpers/e2ee-client.js';
import { startMatrixHarness, type MatrixTestHarness } from './helpers/matrix-harness.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('what the log keeps of a rejection', () => {
	it('names the error, its message and where it was thrown, and nothing it carried', () => {
		const err = Object.assign(new TypeError('cannot read the event'), {
			body: 'what the owner wrote'
		});
		const described = describeRejection(err);
		expect(described['name']).toBe('TypeError');
		expect(described['message']).toBe('cannot read the event');
		const frames = described['frames'] as string[];
		expect(frames.length).toBeGreaterThan(0);
		expect(frames.length).toBeLessThanOrEqual(5);
		expect(frames.every((frame) => frame.startsWith('at '))).toBe(true);
		expect(JSON.stringify(described)).not.toContain('what the owner wrote');
	});

	it('keeps only the type of a rejection that is no error', () => {
		expect(describeRejection('what the owner wrote')).toEqual({ type: 'string' });
		expect(describeRejection({ body: 'what the owner wrote' })).toEqual({ type: 'object' });
	});
});

interface Owner {
	readonly localpart: string;
	readonly name: string;
	client?: E2eeClient;
	room?: string;
}

describe('a push the SDK fails on', () => {
	let h: MatrixTestHarness;
	// vitest's own listeners, which fail the run on any unhandled rejection: they stand aside while
	// the test makes one on purpose
	let vitestListeners: NodeJS.UnhandledRejectionListener[] = [];
	const owners: Owner[] = [
		{ localpart: 'alice', name: 'Jarvis' },
		{ localpart: 'bob', name: 'Friday' }
	];
	const assistantOf = (owner: Owner): string =>
		`@twake-space-assistant-${owner.localpart}:test.local`;

	beforeAll(async () => {
		vitestListeners = process.listeners('unhandledRejection');
		h = await startMatrixHarness();
		for (const owner of owners) {
			const user = await h.synapse.registerUser(owner.localpart);
			owner.client = await startE2eeClient(h.synapse.url, user);
			const created = await h.api.post<{ roomId: string }>(
				`${owner.localpart}@test.local`,
				'/v1/assistants',
				{ name: owner.name }
			);
			expect(created.status).toBe(201);
			const room = created.body.roomId;
			owner.room = room;
			for (let i = 0; i < 40; i += 1) {
				const invites = await h.synapse.pendingInvites(user);
				if (invites.some((invite) => invite.roomId === room)) break;
				await sleep(250);
			}
			await owner.client.joinRoom(room);
			await owner.client.waitForMessage(room, assistantOf(owner), (text) =>
				text.includes(owner.name)
			);
		}
	}, 300_000);
	afterAll(async () => {
		for (const owner of owners) await owner.client?.stop();
		if (h !== undefined) await h.close();
	});

	async function rejectionsCounted(): Promise<number> {
		const response = await fetch(`http://127.0.0.1:${h.port}/metrics`);
		const match = /^harness_unhandled_rejections_total (\d+)$/m.exec(await response.text());
		return Number(match?.[1] ?? Number.NaN);
	}

	it('stays up, counts the rejection, and every assistant still answers', async () => {
		expect(await rejectionsCounted()).toBe(0);
		// A push whose event list holds null: the SDK reads the event's type inside the promise it
		// runs the push in, which nothing awaits, and throws there. It never answers that push either.
		const push = new AbortController();
		for (const listener of vitestListeners) process.off('unhandledRejection', listener);
		try {
			void fetch(`http://127.0.0.1:${h.port}/_matrix/app/v1/transactions/poisoned-1`, {
				method: 'PUT',
				signal: push.signal,
				headers: { 'content-type': 'application/json', authorization: `Bearer ${h.hsToken}` },
				body: JSON.stringify({ events: [null] })
			}).catch(() => undefined);
			for (let i = 0; i < 50 && (await rejectionsCounted()) === 0; i += 1) await sleep(100);
		} finally {
			for (const listener of vitestListeners) process.on('unhandledRejection', listener);
			// Synapse lets such a push go after its timeout, and pushes it again later
			push.abort();
		}
		expect(await rejectionsCounted()).toBe(1);
		expect((await fetch(`http://127.0.0.1:${h.port}/health`)).status).toBe(200);
		const logged = h.logLines().filter((line) => line['msg'] === 'unhandled rejection survived');
		expect(logged).toHaveLength(1);
		expect(logged[0]?.['level']).toBe(50);
		const rejection = logged[0]?.['rejection'] as Record<string, unknown>;
		expect(rejection['name']).toBe('TypeError');
		expect(rejection['message']).toContain("reading 'type'");
		expect((rejection['frames'] as string[]).length).toBeGreaterThan(0);

		// Both assistants still answer: the second one, and the first one too
		for (const owner of [...owners].reverse()) {
			const { client, room } = owner;
			if (client === undefined || room === undefined) throw new Error('owner not set up');
			const text = `still there, ${owner.name}?`;
			await client.sendText(room, text);
			const answer = await client.waitForMessage(
				room,
				assistantOf(owner),
				(body) => body === `echo: ${text}`,
				60_000
			);
			expect(answer).toBe(`echo: ${text}`);
		}
		expect(await rejectionsCounted()).toBe(1);
	});
});
