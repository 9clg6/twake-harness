import { PassThrough } from 'node:stream';
import type { ConfirmChannel } from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeDb, type Db } from '../src/db/client.js';
import { startWorkerRole, type WorkerRole } from '../src/worker/role.js';
import { TEST_DATABASE_URL } from './helpers/app.js';
import { startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import type { ChatMessage, ChatRequest, RecordedCall } from './helpers/fake-apisix.js';
import { startTestBroker, type TestBroker } from './helpers/rabbitmq.js';
import { startTcpProxy, type TcpProxy } from './helpers/tcp-proxy.js';

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
// What the instance's user may do on its vhost: declare and write its own names only, and read
// the activity exchange and its own queues
const PERMISSIONS = {
	configure: `^${PREFIX}\\.`,
	write: `^${PREFIX}\\.`,
	read: `^(activity|${PREFIX}\\..+)$`
};
// What people wrote, which no log line may carry
const CONFIDENTIAL = 'Salary review: Bob leaves in June';
// The first delay of the worker's retries, which doubles from there
const RETRY_DELAY_MS = 50;

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

// Those of one assistant, known by the name its system prompt gives it
function turnsOf(calls: readonly RecordedCall[], eventId: string, name: string): RecordedCall[] {
	return turnCalls(calls, eventId).filter((call) =>
		call.request.messages[0]?.content?.includes(`"${name}"`)
	);
}

describe('an event that fails holds back none of those after it, and is never lost', () => {
	let broker: TestBroker;
	let r: ConsentRoom;
	let worker: WorkerRole;
	// The worker reaches its database through a proxy the tests take down and bring back
	let database: TcpProxy;
	let workerDb: Db;
	const logs = captureLogs();
	beforeAll(async () => {
		broker = await startTestBroker();
		// The exchange the applications publish on, and the instance's user, as the platform makes
		// them: it may declare and write its own names only, and read activity and its own queues
		await broker.channel.assertExchange(ACTIVITY, 'topic', { durable: true });
		await broker.addUser(HARNESS_USER, HARNESS_PASSWORD, PERMISSIONS);
		r = await startConsentRoom({
			ACTIVITY_ENABLED: 'true',
			ACTIVITY_AMQP_URL: broker.urlFor(HARNESS_USER, HARNESS_PASSWORD),
			RABBITMQ_PREFIX: PREFIX
		});
		const databaseUrl = new URL(TEST_DATABASE_URL);
		database = await startTcpProxy(() => ({
			host: databaseUrl.hostname,
			port: Number(databaseUrl.port || '5432')
		}));
		const proxied = new URL(TEST_DATABASE_URL);
		proxied.hostname = '127.0.0.1';
		proxied.port = String(database.port);
		workerDb = makeDb(proxied.toString());
		// Every line the worker writes, down to its debug lines, is read for content
		worker = await startWorkerRole({
			config: { ...r.h.config, role: 'worker', logLevel: 'debug' },
			db: workerDb,
			logStream: logs.stream,
			retryDelayMs: RETRY_DELAY_MS
		});
		// A literal model: it says which event it was told of
		r.h.apisix.llm.script = (request: ChatRequest) => {
			const id = /\(id ([^)]+)\)/.exec(lastUser(request))?.[1];
			return { content: id === undefined ? 'Heard you.' : `Told of (${id})` };
		};
	}, 240_000);
	afterAll(async () => {
		if (worker !== undefined) await worker.stop();
		if (workerDb !== undefined) await workerDb.close();
		if (database !== undefined) await database.close();
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

	// A fault every attempt meets, as a bug would be: the database refuses the wake-ups it matches
	async function refuseWakeups(when: string): Promise<void> {
		await r.h.db.sql.unsafe(`create or replace function refuse_wakeup() returns trigger
			language plpgsql as $$ begin raise exception 'wake-up refused'; end $$`);
		await r.h.db.sql.unsafe(`create trigger refuse_wakeup before insert on wakeups for each row
			when (${when}) execute function refuse_wakeup()`);
	}

	// The fault fixed
	async function allowWakeups(): Promise<void> {
		await r.h.db.sql.unsafe('drop trigger if exists refuse_wakeup on wakeups');
	}

	// What a worker's health check says of its listener
	async function healthOf(role: WorkerRole): Promise<unknown> {
		const health = await role.app.inject({ method: 'GET', url: '/health' });
		expect(health.statusCode).toBe(200);
		return health.json<{ activity?: string }>().activity;
	}

	// A worker of its own, on a vhost of its own, as the instance's user there
	function workerOn(amqpUrl: string, logStream: PassThrough): Promise<WorkerRole> {
		return startWorkerRole({
			config: { ...r.h.config, role: 'worker', activity: { amqpUrl, types: [ASSIGNED] } },
			db: r.h.db,
			logStream,
			retryDelayMs: RETRY_DELAY_MS
		});
	}

	// Publishes an event as Twake Tasks does, on a vhost of its own
	async function publishOn(channel: ConfirmChannel, event: ActivityEvent): Promise<void> {
		channel.publish(ACTIVITY, event.type, Buffer.from(JSON.stringify(event)), {
			persistent: true,
			messageId: event.id
		});
		await channel.waitForConfirms();
	}

	// The lines of the attempts at an event that failed, once there are that many
	async function failuresOf(event: ActivityEvent, count: number): Promise<LogLine[]> {
		for (let i = 0; i < 240; i += 1) {
			const failures = logs
				.lines()
				.filter((line) => line['msg'] === 'event failed' && line['eventId'] === event.id);
			if (failures.length >= count) return failures;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error(`fewer than ${count} failed attempts at ${event.id}`);
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

	it('tries an event again while the database is down, ever further apart, then wakes me once', async () => {
		await broker.channel.purgeQueue(DEAD_LETTERS);
		const mark = logs.lines().length;
		const event = activityEvent();
		database.cut();
		try {
			await publish(event);
			// Tried more than the five times a lasting failure gets, never dead-lettered, and held
			const failures = await failuresOf(event, 7);
			expect(failures.map((line) => line['transient'])).toEqual(Array(7).fill(true));
			expect((await broker.queue(DEAD_LETTERS))?.messages).toBe(0);
			expect((await broker.queue(QUEUE))?.messages).toBe(1);
			// Each wait twice as long as the one before it
			const times = failures.map((line) => Number(line['time']));
			for (let i = 1; i < times.length; i += 1) {
				expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(
					RETRY_DELAY_MS * 2 ** (i - 1) - 2
				);
			}
		} finally {
			database.restore();
		}
		await toldOf(event);
		expect(turnCalls(r.h.apisix.llm.calls, event.id)).toHaveLength(1);
		expect((await broker.queue(DEAD_LETTERS))?.messages).toBe(0);
		expect(handled(mark).map(({ eventId, outcome }) => ({ eventId, outcome }))).toEqual([
			{ eventId: event.id, outcome: 'woken' }
		]);
	});

	it('dead-letters an event that keeps failing after five attempts, and goes on with the next', async () => {
		await broker.channel.purgeQueue(DEAD_LETTERS);
		const mark = logs.lines().length;
		const failing = activityEvent();
		const next = activityEvent();
		await refuseWakeups(`new.event_id = '${failing.id}'`);
		try {
			await publish(failing);
			await publish(next);
			await toldOf(next);
		} finally {
			await allowWakeups();
		}
		const failures = await failuresOf(failing, 5);
		expect(failures.map((line) => line['transient'])).toEqual(Array(5).fill(false));
		expect((await broker.queue(DEAD_LETTERS))?.messages).toBe(1);
		expect(turnCalls(r.h.apisix.llm.calls, failing.id)).toHaveLength(0);
		expect(
			handled(mark).map(({ eventId, outcome, reason }) => ({ eventId, outcome, reason }))
		).toEqual([
			{ eventId: failing.id, outcome: 'dead_lettered', reason: 'failed 5 times' },
			{ eventId: next.id, outcome: 'woken', reason: undefined }
		]);
	});

	it('wakes nobody twice when its dead letters are replayed once the fault is fixed', async () => {
		await broker.channel.purgeQueue(DEAD_LETTERS);
		// Carol has an assistant too, whose wake-ups the database refuses for now
		await r.h.synapse.registerUser('carol');
		const created = await r.h.api.post('carol@test.local', '/v1/assistants', { name: 'Friday' });
		expect(created.status).toBe(201);
		const carol = { email: 'carol@test.local', reason: 'assigned' };
		const event = activityEvent([ALICE, carol]);
		await refuseWakeups(`new.owner = 'carol@test.local'`);
		try {
			// Alice is told at the first attempt, and the event is dead-lettered for Carol's sake
			await publish(event);
			await toldOf(event);
			await failuresOf(event, 5);
			await until(
				'the event dead-lettered',
				async () => (await broker.queue(DEAD_LETTERS))?.messages === 1
			);
		} finally {
			await allowWakeups();
		}
		const mark = logs.lines().length;
		expect(await broker.replay(DEAD_LETTERS, QUEUE)).toBe(1);
		await until('Carol told', () => turnsOf(r.h.apisix.llm.calls, event.id, 'Friday').length > 0);
		expect(
			handled(mark).map(({ eventId, outcome, outcomes }) => ({ eventId, outcome, outcomes }))
		).toEqual([{ eventId: event.id, outcome: 'woken', outcomes: { duplicate: 1, woken: 1 } }]);
		expect(turnsOf(r.h.apisix.llm.calls, event.id, 'Jarvis')).toHaveLength(1);
		expect(turnsOf(r.h.apisix.llm.calls, event.id, 'Friday')).toHaveLength(1);
		expect((await broker.queue(DEAD_LETTERS))?.messages).toBe(0);
		expect((await broker.queue(QUEUE))?.messages).toBe(0);
	});

	it('starts without the activity exchange, holds no connection while it waits, and listens once it is there', async () => {
		const channel = await broker.addVhost('late');
		await broker.addUser('twake-harness-late', HARNESS_PASSWORD, PERMISSIONS);
		await broker.allow('twake-harness-late', 'late', PERMISSIONS);
		const lateLogs = captureLogs();
		const late = await workerOn(
			broker.urlFor('twake-harness-late', HARNESS_PASSWORD, 'late'),
			lateLogs.stream
		);
		const connections = async (): Promise<number> =>
			(await broker.connectedUsers()).filter((user) => user === 'twake-harness-late').length;
		try {
			expect(await healthOf(late)).toBe('disconnected');
			await until(
				'three attempts',
				() => lateLogs.lines().filter((line) => line['msg'] === 'listen failed').length >= 3
			);
			// Each attempt closes its connection once it failed, so that none piles up
			expect(await connections()).toBeLessThanOrEqual(1);
			// The platform declares the exchange
			await channel.assertExchange(ACTIVITY, 'topic', { durable: true });
			await until('listening', async () => (await healthOf(late)) === 'connected');
			const event = activityEvent();
			await publishOn(channel, event);
			await toldOf(event);
		} finally {
			await late.stop();
		}
		await until('no connection left', async () => (await connections()) === 0);
	});

	it('starts while the broker is out of reach, tries again and again, and listens once it is back', async () => {
		const channel = await broker.addVhost('away');
		await channel.assertExchange(ACTIVITY, 'topic', { durable: true });
		await broker.addUser('twake-harness-away', HARNESS_PASSWORD, PERMISSIONS);
		await broker.allow('twake-harness-away', 'away', PERMISSIONS);
		const proxy = await startTcpProxy(() => broker.address());
		proxy.cut();
		const url = new URL(broker.urlFor('twake-harness-away', HARNESS_PASSWORD, 'away'));
		url.hostname = '127.0.0.1';
		url.port = String(proxy.port);
		const awayLogs = captureLogs();
		const away = await workerOn(url.toString(), awayLogs.stream);
		try {
			expect(await healthOf(away)).toBe('disconnected');
			await until(
				'three attempts',
				() => awayLogs.lines().filter((line) => line['msg'] === 'listen failed').length >= 3
			);
			proxy.restore();
			await until('listening', async () => (await healthOf(away)) === 'connected');
			const event = activityEvent();
			await publishOn(channel, event);
			await toldOf(event);
		} finally {
			await away.stop();
			await proxy.close();
		}
	});
});

// Waits for what a condition tells, a minute at most
async function until(what: string, condition: () => Promise<boolean> | boolean): Promise<void> {
	for (let i = 0; i < 240; i += 1) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`${what}: not within a minute`);
}
