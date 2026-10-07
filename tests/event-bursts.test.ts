import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startWorkerRole, type WorkerRole } from '../src/worker/role.js';
import {
	ACTIVITY,
	ASSIGNED,
	HARNESS_PASSWORD,
	HARNESS_USER,
	lastUser,
	logSink,
	PREFIX,
	startActivityBroker,
	toldOf,
	turnCalls,
	type LogSink
} from './helpers/activity.js';
import { startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import type { ChatRequest, ScriptedReply } from './helpers/fake-apisix.js';
import type { TestBroker } from './helpers/rabbitmq.js';

const ALICE = { email: 'alice@test.local', reason: 'assigned' };
const CAROL = { email: 'carol@test.local', reason: 'assigned' };

// What Twake Tasks publishes when Bob assigns a task: a CloudEvent naming the assignees in
// data.recipients
interface Assignment extends Record<string, unknown> {
	readonly id: string;
	readonly type: string;
}

let serial = 0;

function assignment(recipients: readonly Record<string, unknown>[] = [ALICE]): Assignment {
	serial += 1;
	return {
		specversion: '1.0',
		id: `0199b6f3-${String(serial).padStart(4, '0')}-7c3e-8a1f-6d2b4e8c9a07`,
		source: 'twake://tasks',
		type: ASSIGNED,
		time: '2026-10-07T14:41:40.123456Z',
		twakeactor: 'bob@test.local',
		data: {
			object: { type: 'task', id: `task-${serial}`, key: `ROAD-${serial}`, title: 'Write it' },
			recipients
		}
	};
}

// A literal model: it names the event it was told of, and repeats anything else it hears
function literal(request: ChatRequest): ScriptedReply {
	const told = lastUser(request);
	const id = /\(id ([^)]+)\)/.exec(told)?.[1];
	return { content: id === undefined ? `Heard: ${told}` : `Told of ${id}` };
}

let broker: TestBroker;

beforeAll(async () => {
	broker = await startActivityBroker();
}, 120_000);

afterAll(async () => {
	if (broker !== undefined) await broker.stop();
});

// Alice in her assistant's room, the worker role listening to the activity exchange on a queue of
// the suite's own, under the settings given
interface Listening {
	readonly r: ConsentRoom;
	readonly queue: string;
	// The log lines of the worker roles the suite starts
	readonly logs: LogSink;
	listen(): Promise<WorkerRole>;
	publish(event: Assignment): Promise<void>;
	// What Alice's assistant told her of an event, in her room
	answerTo(event: Assignment, timeoutMs?: number): Promise<string>;
	close(): Promise<void>;
}

async function startListening(suite: string, env: Record<string, string>): Promise<Listening> {
	const prefix = `${PREFIX}.${suite}`;
	const r = await startConsentRoom({
		ACTIVITY_ENABLED: 'true',
		ACTIVITY_AMQP_URL: broker.urlFor(HARNESS_USER, HARNESS_PASSWORD),
		RABBITMQ_PREFIX: prefix,
		...env
	});
	r.h.apisix.llm.script = literal;
	const logs = logSink();
	return {
		r,
		queue: `${prefix}.activity`,
		logs,
		listen: () =>
			startWorkerRole({
				config: { ...r.h.config, role: 'worker' },
				db: r.h.db,
				logStream: logs.stream
			}),
		publish: (event) => broker.publish(ACTIVITY, event.type, event, event.id),
		answerTo: (event, timeoutMs) =>
			r.client.waitForMessage(
				r.room,
				r.assistantId,
				(text) => text === `Told of ${event.id}`,
				timeoutMs
			),
		close: () => r.close()
	};
}

describe('a burst of assignments', () => {
	let l: Listening;
	beforeAll(async () => {
		// Twenty turns in a row are no flood to admission
		l = await startListening('burst', { ADMISSION_USER_PER_MINUTE: '100' });
		// Carol has an assistant too
		await l.r.h.synapse.registerUser('carol');
		const created = await l.r.h.api.post('carol@test.local', '/v1/assistants', { name: 'Friday' });
		expect(created.status).toBe(201);
	}, 240_000);
	afterAll(async () => {
		if (l !== undefined) await l.close();
	});

	it('wakes my assistant for twenty of my twenty-one assignments of the hour, and Carol’s for hers', async () => {
		const mine = Array.from({ length: 21 }, () => assignment());
		const [tenth, last] = [mine[9], mine[20]];
		if (tenth === undefined || last === undefined) throw new Error('no assignments');
		// Counted in the database: a worker started again halfway through knows the first ten
		let worker = await l.listen();
		for (const event of mine.slice(0, 10)) await l.publish(event);
		await l.answerTo(tenth);
		await worker.stop();
		worker = await l.listen();
		try {
			for (const event of mine.slice(10)) await l.publish(event);
			// Carol's, published last, is told once the queue, read in order, has taken all of mine
			const carols = assignment([CAROL]);
			await l.publish(carols);
			await toldOf(l.r.h.apisix, carols.id, 1);
			// My own words wait behind every turn the assignments queued for my assistant, and are
			// answered all the same
			await l.r.client.sendText(l.r.room, 'Anything else?');
			await l.r.client.waitForMessage(
				l.r.room,
				l.r.assistantId,
				(text) => text === 'Heard: Anything else?'
			);
			for (const event of mine.slice(0, 20)) await l.answerTo(event);
			expect(turnCalls(l.r.h.apisix.llm.calls, last.id)).toHaveLength(0);
			expect(l.logs.lines()).toContainEqual(
				expect.objectContaining({
					msg: 'event capped',
					source: 'twake://tasks',
					eventId: last.id,
					type: ASSIGNED,
					owner: 'alice@test.local'
				})
			);
			// Taken all the same, and not dead-lettered
			expect((await broker.queue(l.queue))?.messages).toBe(0);
			expect((await broker.queue(`${l.queue}.dlq`))?.messages).toBe(0);
		} finally {
			await worker.stop();
		}
	});
});
