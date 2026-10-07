import { Writable } from 'node:stream';

import type { ChatRequest, FakeApisix, RecordedCall } from './fake-apisix.js';
import { startTestBroker, type TestBroker } from './rabbitmq.js';

// Where the applications publish what happens to people, and what Twake Tasks publishes there
// when someone assigns a task
export const ACTIVITY = 'activity';
export const ASSIGNED = 'com.twake.tasks.task.assigned.v1';

// The instance's own names on the broker, and its own user there
export const PREFIX = 'twake-harness-test';
export const HARNESS_USER = 'twake-harness-test';
export const HARNESS_PASSWORD = 'harness-test-password';

// The platform's broker with the exchange the applications publish on, as the platform declares
// it, and the instance's user, as the platform creates it: it may declare and write its own names
// only, and read the activity exchange and its own queues
export async function startActivityBroker(): Promise<TestBroker> {
	const broker = await startTestBroker();
	await broker.channel.assertExchange(ACTIVITY, 'topic', { durable: true });
	await broker.addUser(HARNESS_USER, HARNESS_PASSWORD, {
		configure: `^${PREFIX}\\.`,
		write: `^${PREFIX}\\.`,
		read: `^(${ACTIVITY}|${PREFIX}\\..+)$`
	});
	return broker;
}

export function lastUser(request: ChatRequest | undefined): string {
	return request?.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
}

// The model calls of the turn whose message names this event, in order
export function turnCalls(calls: readonly RecordedCall[], eventId: string): RecordedCall[] {
	return calls.filter((call) => lastUser(call.request).includes(`(id ${eventId})`));
}

// The model calls of the turns an event started, once there are that many
export async function toldOf(
	apisix: FakeApisix,
	eventId: string,
	count: number
): Promise<RecordedCall[]> {
	for (let i = 0; i < 120; i += 1) {
		const calls = turnCalls(apisix.llm.calls, eventId);
		if (calls.length >= count) return calls;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`fewer than ${count} turns of ${eventId}`);
}

// A log stream that keeps nothing, for a role whose logs a test does not read
export function silent(): Writable {
	return new Writable({ write: (_chunk, _encoding, done) => done() });
}

// A log stream that keeps the lines a role writes, for a test to read them
export interface LogSink {
	readonly stream: Writable;
	lines(): Record<string, unknown>[];
}

export function logSink(): LogSink {
	const chunks: string[] = [];
	return {
		stream: new Writable({
			write: (chunk: Buffer, _encoding, done) => {
				chunks.push(chunk.toString('utf8'));
				done();
			}
		}),
		lines: () =>
			chunks
				.join('')
				.split('\n')
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
	};
}
