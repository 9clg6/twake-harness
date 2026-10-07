import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startWorkerRole, type WorkerRole } from '../src/worker/role.js';
import { startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import type { ChatMessage, ChatRequest, RecordedCall } from './helpers/fake-apisix.js';
import { startTestBroker, type TestBroker } from './helpers/rabbitmq.js';

const ACTIVITY = 'activity';
const ASSIGNED = 'com.twake.tasks.task.assigned.v1';
// A type the deployment does not listen to
const COMPLETED = 'com.twake.tasks.task.completed.v1';
// The instance's own names on the broker, and its own user there
const PREFIX = 'twake-harness-test';
const QUEUE = `${PREFIX}.activity`;
const DEAD_LETTERS = `${QUEUE}.dlq`;
const HARNESS_USER = 'twake-harness-test';
const HARNESS_PASSWORD = 'harness-test-password';
// What people wrote, which no log line may carry
const CONFIDENTIAL = 'Salary review: Bob leaves in June';

const ALICE = { email: 'alice@test.local', reason: 'assigned' };

type LogLine = Record<string, unknown>;

// What a role writes to its logs, line by line
interface LogCapture {
	readonly stream: PassThrough;
	lines(): LogLine[];
	text(): string;
}

function captureLogs(): LogCapture {
	const stream = new PassThrough();
	const chunks: string[] = [];
	stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
	const text = (): string => chunks.join('');
	return {
		stream,
		text,
		lines: () =>
			text()
				.split('\n')
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as LogLine)
	};
}

// What an application publishes: a CloudEvent naming the people it is for in data.recipients
interface ActivityEvent extends Record<string, unknown> {
	readonly id: string;
	readonly type: string;
}

let serial = 0;

// A task assigned by Bob, published as Twake Tasks does, for Alice unless told otherwise
function activityEvent(recipients: readonly Record<string, unknown>[] = [ALICE]): ActivityEvent {
	serial += 1;
	return {
		specversion: '1.0',
		id: `0199c0de-${String(serial).padStart(4, '0')}-7c3e-8a1f-6d2b4e8c9a07`,
		source: 'twake://tasks',
		type: ASSIGNED,
		time: '2026-10-07T14:41:40.123456Z',
		twakeactor: 'bob@test.local',
		data: {
			object: { type: 'task', id: `task-${serial}`, key: `ROAD-${serial}`, title: CONFIDENTIAL },
			recipients
		}
	};
}

function lastUser(request: ChatRequest | undefined): string {
	return request?.messages.filter((m: ChatMessage) => m.role === 'user').at(-1)?.content ?? '';
}

// The model calls of the turns whose message names this event
function turnCalls(calls: readonly RecordedCall[], eventId: string): RecordedCall[] {
	return calls.filter((call) => lastUser(call.request).includes(`(id ${eventId})`));
}

describe('an event that fails holds back none of those after it, and is never lost', () => {
	let broker: TestBroker;
	let r: ConsentRoom;
	let worker: WorkerRole;
	const logs = captureLogs();
	beforeAll(async () => {
		broker = await startTestBroker();
		// The exchange the applications publish on, and the instance's user, as the platform makes
		// them: it may declare and write its own names only, and read activity and its own queues
		await broker.channel.assertExchange(ACTIVITY, 'topic', { durable: true });
		await broker.addUser(HARNESS_USER, HARNESS_PASSWORD, {
			configure: `^${PREFIX}\\.`,
			write: `^${PREFIX}\\.`,
			read: `^(${ACTIVITY}|${PREFIX}\\..+)$`
		});
		r = await startConsentRoom({
			ACTIVITY_ENABLED: 'true',
			ACTIVITY_AMQP_URL: broker.urlFor(HARNESS_USER, HARNESS_PASSWORD),
			RABBITMQ_PREFIX: PREFIX
		});
		// Every line the worker writes, down to its debug lines, is read for content
		worker = await startWorkerRole({
			config: { ...r.h.config, role: 'worker', logLevel: 'debug' },
			db: r.h.db,
			logStream: logs.stream
		});
		// A literal model: it says which event it was told of
		r.h.apisix.llm.script = (request: ChatRequest) => {
			const id = /\(id ([^)]+)\)/.exec(lastUser(request))?.[1];
			return { content: id === undefined ? 'Heard you.' : `Told of (${id})` };
		};
	}, 240_000);
	afterAll(async () => {
		if (worker !== undefined) await worker.stop();
		if (r !== undefined) await r.close();
		if (broker !== undefined) await broker.stop();
	});

	function publish(event: ActivityEvent): Promise<void> {
		return broker.publish(ACTIVITY, event.type, event, event.id);
	}

	// Waits until Alice's assistant told her of an event in her room
	async function toldOf(event: ActivityEvent): Promise<void> {
		await r.client.waitForMessage(r.room, r.assistantId, (t) => t === `Told of (${event.id})`);
	}

	// The line the worker logged once it was done with a message
	function handled(since: number): LogLine[] {
		return logs
			.lines()
			.slice(since)
			.filter((line) => line['msg'] === 'event handled');
	}

	it('dead-letters at once a message that is no event, logging why and nothing of what it says', async () => {
		await broker.channel.purgeQueue(DEAD_LETTERS);
		const mark = logs.lines().length;
		// Not JSON at all, then a CloudEvent without its source, then one about no object
		broker.channel.publish(ACTIVITY, ASSIGNED, Buffer.from(`${CONFIDENTIAL} {`), {
			persistent: true,
			messageId: 'not-json'
		});
		await broker.channel.waitForConfirms();
		const withoutSource: ActivityEvent = { ...activityEvent(), source: undefined };
		const aboutNothing = activityEvent();
		const withoutObject: ActivityEvent = {
			...aboutNothing,
			data: { recipients: [ALICE], preview: CONFIDENTIAL }
		};
		await publish(withoutSource);
		await publish(withoutObject);
		// The next event is told as ever
		const next = activityEvent();
		await publish(next);
		await toldOf(next);
		expect((await broker.queue(DEAD_LETTERS))?.messages).toBe(3);
		expect(turnCalls(r.h.apisix.llm.calls, withoutSource.id)).toHaveLength(0);
		expect(turnCalls(r.h.apisix.llm.calls, withoutObject.id)).toHaveLength(0);
		expect(
			handled(mark).map(({ eventId, type, outcome, reason }) => ({
				eventId,
				type,
				outcome,
				reason
			}))
		).toEqual([
			{ eventId: undefined, type: ASSIGNED, outcome: 'dead_lettered', reason: 'not JSON' },
			{ eventId: withoutSource.id, type: ASSIGNED, outcome: 'dead_lettered', reason: 'no source' },
			{
				eventId: withoutObject.id,
				type: ASSIGNED,
				outcome: 'dead_lettered',
				reason: 'no data.object'
			},
			{ eventId: next.id, type: ASSIGNED, outcome: 'woken', reason: undefined }
		]);
		expect(logs.text()).not.toContain('Salary review');
	});

	it('logs one line per event, with what came of each recipient and nothing anyone wrote', async () => {
		const mark = logs.lines().length;
		const dave = { email: 'dave@test.local', reason: 'assigned' };
		const elsewhere = { email: 'alice@elsewhere.test', reason: 'assigned' };
		const unreadable = { email: 'not an address', reason: 'assigned' };
		const many = activityEvent([ALICE, dave, elsewhere, unreadable]);
		const nobody = activityEvent([]);
		// Of a type the deployment no longer listens to, whose binding stays on the broker until it
		// is removed there
		const completed: ActivityEvent = { ...activityEvent(), type: COMPLETED };
		await broker.channel.bindQueue(QUEUE, ACTIVITY, COMPLETED);
		const next = activityEvent();
		try {
			await publish(many);
			await toldOf(many);
			// Delivered again, as after a restart
			await publish(many);
			await publish(nobody);
			await publish(completed);
			await publish(next);
			await toldOf(next);
		} finally {
			await broker.channel.unbindQueue(QUEUE, ACTIVITY, COMPLETED);
		}
		expect(turnCalls(r.h.apisix.llm.calls, many.id)).toHaveLength(1);
		expect(turnCalls(r.h.apisix.llm.calls, completed.id)).toHaveLength(0);
		expect(
			handled(mark).map(({ eventId, recipients, outcome, outcomes, reason }) => ({
				eventId,
				recipients,
				outcome,
				outcomes,
				reason
			}))
		).toEqual([
			{
				eventId: many.id,
				recipients: 4,
				outcome: 'woken',
				outcomes: { woken: 1, no_assistant: 1, ignored: 1, invalid: 1 }
			},
			{
				eventId: many.id,
				recipients: 4,
				outcome: 'duplicate',
				outcomes: { duplicate: 1, no_assistant: 1, ignored: 1, invalid: 1 }
			},
			{ eventId: nobody.id, recipients: 0, outcome: 'ignored', outcomes: {} },
			{ eventId: completed.id, recipients: 1, outcome: 'ignored', reason: 'type not listened to' },
			{ eventId: next.id, recipients: 1, outcome: 'woken', outcomes: { woken: 1 } }
		]);
		expect(logs.text()).not.toContain('Salary review');
	});
});
