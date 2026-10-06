import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeListenerGuard, makeWorkTracker, type ErrorLog } from '../src/matrix/listeners.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('a guarded matrix listener', () => {
	const errors: { fields: Record<string, unknown>; msg: string }[] = [];
	const log: ErrorLog = {
		error: (fields, msg) => {
			errors.push({ fields, msg });
		}
	};
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};
	beforeEach(() => {
		errors.length = 0;
		unhandled.length = 0;
		process.on('unhandledRejection', onUnhandled);
	});
	afterEach(() => {
		process.off('unhandledRejection', onUnhandled);
	});

	it('logs a failure with the ids of what it handled, and leaves no unhandled rejection', async () => {
		const guard = makeListenerGuard(log);
		const listener = guard(
			'room message',
			async (roomId: string, body: string) => {
				await sleep(1);
				throw new Error(`could not save the assistant for ${roomId} (${body.length} characters)`);
			},
			(roomId: string) => ({ roomId })
		);
		listener('!room:test.local', 'what the owner wrote');
		await sleep(50);
		expect(unhandled).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.msg).toBe('room message failed');
		expect(errors[0]?.fields['roomId']).toBe('!room:test.local');
		expect(errors[0]?.fields['err']).toBeInstanceOf(Error);
		// The context names what was handled, never what it said
		expect(JSON.stringify(errors[0]?.fields)).not.toContain('what the owner wrote');
	});

	it('runs a listener that succeeds to its end and logs nothing', async () => {
		const guard = makeListenerGuard(log);
		const seen: string[] = [];
		const listener = guard(
			'room event',
			async (roomId: string) => {
				await sleep(1);
				seen.push(roomId);
			},
			(roomId: string) => ({ roomId })
		);
		listener('!a:test.local');
		listener('!b:test.local');
		await sleep(50);
		expect(seen).toEqual(['!a:test.local', '!b:test.local']);
		expect(errors).toEqual([]);
		expect(unhandled).toEqual([]);
	});

	it('counts a listener as work under way until it settles, whether it fails or not', async () => {
		const tracker = makeWorkTracker();
		const guard = makeListenerGuard(log, tracker);
		const seen: string[] = [];
		const succeeds = guard(
			'room event',
			async (roomId: string) => {
				await sleep(30);
				seen.push(roomId);
			},
			(roomId: string) => ({ roomId })
		);
		const fails = guard(
			'room message',
			async (roomId: string) => {
				await sleep(60);
				throw new Error(`could not answer in ${roomId}`);
			},
			(roomId: string) => ({ roomId })
		);
		succeeds('!a:test.local');
		fails('!b:test.local');
		expect(tracker.size).toBe(2);
		await sleep(45);
		expect(tracker.size).toBe(1);
		await sleep(45);
		expect(tracker.size).toBe(0);
		expect(seen).toEqual(['!a:test.local']);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.msg).toBe('room message failed');
		expect(unhandled).toEqual([]);
	});
});
