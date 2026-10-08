import { MatrixClient } from 'matrix-bot-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uniqueToDeviceTransactions } from '../src/matrix/encryption.js';

describe("the to-device sends of the application service's users", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('name their transactions apart, even when two users send at the same instant', async () => {
		// Synapse keys an application service's transactions by path and service only: two of its users
		// sending under one path would make the second send a repeat of the first, which it drops
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-08T08:00:00Z'));
		const paths: string[] = [];
		const clients = [
			new MatrixClient('http://synapse', 'as-token'),
			new MatrixClient('http://synapse', 'as-token')
		];
		for (const client of clients) {
			client.doRequest = (method: string, path: string): Promise<unknown> => {
				paths.push(`${method} ${path}`);
				return Promise.resolve({});
			};
			uniqueToDeviceTransactions(client);
		}
		for (const client of clients) {
			// The crypto engine marks the request sent with what the homeserver answered
			await expect(
				client.sendToDevices('m.room.encrypted', { '@owner:test.local': { DEVICE: {} } })
			).resolves.toEqual({});
		}
		expect(paths).toHaveLength(2);
		expect(
			paths.every((p) => p.startsWith('PUT /_matrix/client/v3/sendToDevice/m.room.encrypted/'))
		).toBe(true);
		expect(paths[0]).not.toBe(paths[1]);
	});
});
