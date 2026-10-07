import { Writable } from 'node:stream';

import type { Config } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { startWorkerRole, type WorkerRole } from '../../src/worker/role.js';
import {
	lastUserContent,
	type ChatRequest,
	type FakeApisix,
	type RecordedCall
} from './fake-apisix.js';
import { startTestBroker, type TestBroker } from './rabbitmq.js';

// Where the applications publish what happens to people, and what Twake Tasks publishes there
// when someone assigns a task
export const ACTIVITY = 'activity';
export const ASSIGNED = 'com.twake.tasks.task.assigned.v1';
// What an invitation is named there, where a team calendar may publish one
export const INVITED = 'com.twake.calendar.event.invited.v1';

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

// What the owner said last in a request to the model, or nothing, as the fake gateway reads it
export function lastUser(request: ChatRequest | undefined): string {
	return request === undefined ? '' : lastUserContent(request);
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

// An event as an application publishes it on the activity exchange: a CloudEvent naming the
// person it is for in data.recipients
export interface ActivityEvent extends Record<string, unknown> {
	readonly id: string;
	readonly type: string;
}

// The platform's broker with its activity exchange, and the worker role of the harness that
// listens there
export interface ActivityExchange {
	// What the harness is set with to listen there, as the instance's own user
	readonly settings: Readonly<Record<string, string>>;
	// Starts the worker role on the harness's database, which listens as its settings say
	listen(h: { readonly config: Config; readonly db: Db }): Promise<void>;
	// Publishes an event as its application does: routed by its type, persistent, under its id
	publish(event: ActivityEvent): Promise<void>;
	// Stops the worker role, then the broker
	close(): Promise<void>;
}

// The activity broker, for a suite that only needs the harness to listen to the types given, and
// whose worker's logs it does not read
export async function startActivityExchange(
	types: readonly string[] = [ASSIGNED]
): Promise<ActivityExchange> {
	const broker = await startActivityBroker();
	let worker: WorkerRole | null = null;
	return {
		settings: {
			ACTIVITY_ENABLED: 'true',
			ACTIVITY_AMQP_URL: broker.urlFor(HARNESS_USER, HARNESS_PASSWORD),
			ACTIVITY_TYPES: types.join(','),
			RABBITMQ_PREFIX: PREFIX
		},
		listen: async (h) => {
			worker = await startWorkerRole({
				config: { ...h.config, role: 'worker' },
				db: h.db,
				logStream: silent()
			});
		},
		publish: (event) => broker.publish(ACTIVITY, event.type, event, event.id),
		close: async () => {
			await worker?.stop();
			await broker.stop();
		}
	};
}

export interface ActivityEventOptions {
	readonly id: string;
	// The email of the person it is for
	readonly recipient: string;
	// Bob assigning them the task ROAD-12 of the Roadmap board, unless told otherwise
	readonly type?: string;
	readonly source?: string;
	readonly reason?: string;
	readonly object?: Record<string, unknown>;
}

export function activityEvent(options: ActivityEventOptions): ActivityEvent {
	return {
		specversion: '1.0',
		id: options.id,
		source: options.source ?? 'twake://tasks',
		type: options.type ?? ASSIGNED,
		time: '2026-10-07T14:41:40Z',
		twakeactor: 'bob@test.local',
		data: {
			object: options.object ?? {
				type: 'task',
				id: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
				key: 'ROAD-12',
				title: 'Write the quarterly report',
				board: { id: '3c4d5e6f-7a8b-4c9d-8e0f-a1b2c3d4e5f6', name: 'Roadmap' }
			},
			recipients: [{ email: options.recipient, reason: options.reason ?? 'assigned' }]
		}
	};
}

// An invitation to the budget review, as a team calendar publishes it on the activity exchange
export function invitationEvent(
	id: string,
	recipient: string,
	title = 'Budget review'
): ActivityEvent {
	return activityEvent({
		id,
		recipient,
		type: INVITED,
		source: 'twake://calendar',
		reason: 'invited',
		object: { type: 'event', id: `event-${id}`, title }
	});
}
