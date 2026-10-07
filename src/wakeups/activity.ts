import { DeadLetterError, RabbitMQClient } from '@linagora/rabbitmq-client';
import { z } from 'zod';

import type { ActivitySource } from '../config.js';
import { wake, type WakeDeps, type Wakeup } from './wake.js';

// Where the applications publish what happens to people, as CloudEvents routed by their type
const ACTIVITY_EXCHANGE = 'activity';

// How many times a message may come back before it is dead-lettered, as one that brings the
// worker down whenever it is delivered: set, since RabbitMQ 3.13 has no limit and 4.0 one of 20,
// and fixed once the queue is declared
const DELIVERY_LIMIT = 5;

const recipientSchema = z.object({
	uuid: z.uuid().optional(),
	email: z.email().optional(),
	// Any reason the application gives, such as assigned
	reason: z.string().min(1).max(100)
});

// A CloudEvent 1.0 in structured JSON, as ADR 001 and 006 shape them: what its object is, and the
// people it is for
const activityEventSchema = z.object({
	specversion: z.literal('1.0'),
	id: z.string().min(1).max(200),
	source: z.string().min(1).max(200),
	type: z.string().min(1).max(200),
	time: z.iso.datetime({ offset: true }).optional(),
	twakeorg: z.string().min(1).max(200).optional(),
	twakeactor: z.email().optional(),
	twakeactorid: z.uuid().optional(),
	data: z.object({
		object: z.object({
			type: z.string().min(1).max(100),
			id: z.string().min(1).max(200),
			title: z.string().max(1000),
			key: z.string().min(1).max(100).optional(),
			board: z.object({ id: z.string().min(1).max(200), name: z.string().max(200) }).optional(),
			container: z
				.object({ kind: z.string().min(1).max(100), id: z.string().min(1).max(200) })
				.optional(),
			url: z
				.url({ protocol: /^https?$/ })
				.max(2000)
				.optional()
		}),
		// Exactly who the event is for: nobody is inferred
		recipients: z.array(recipientSchema).max(100).default([])
	})
});

type ActivityEvent = z.infer<typeof activityEventSchema>;

// One wake-up per recipient. What the application computed (its ids, key, link and time, and who
// acted) is shown apart from what people wrote (the title and the board's name), as the contracts
// return it under untrusted.
function wakeupsOf(event: ActivityEvent): Wakeup[] {
	const { object } = event.data;
	const computedObject = {
		type: object.type,
		id: object.id,
		...(object.key === undefined ? {} : { key: object.key }),
		...(object.board === undefined ? {} : { board_id: object.board.id }),
		...(object.container === undefined ? {} : { container: object.container }),
		...(object.url === undefined ? {} : { url: object.url })
	};
	const untrusted = {
		title: object.title,
		...(object.board === undefined ? {} : { board_name: object.board.name })
	};
	return event.data.recipients.map((recipient) => ({
		source: event.source,
		id: event.id,
		type: event.type,
		recipient: {
			email: recipient.email ?? null,
			uuid: recipient.uuid ?? null,
			reason: recipient.reason
		},
		actor: { email: event.twakeactor ?? null, uuid: event.twakeactorid ?? null },
		shown: {
			computed: {
				type: event.type,
				source: event.source,
				id: event.id,
				...(event.time === undefined ? {} : { time: event.time }),
				...(event.twakeactor === undefined ? {} : { actor: event.twakeactor }),
				reason: recipient.reason,
				object: computedObject
			},
			untrusted
		}
	}));
}

export interface ActivityListener {
	close(): Promise<void>;
}

// Listens to the activity exchange on the instance's own quorum queue, one message at a time and
// with a single active consumer, so that events keep their order whatever the replicas, and wakes
// the assistant of each recipient of an event; a message is taken once what it wakes is written.
export async function startActivityListener(
	deps: WakeDeps,
	source: ActivitySource
): Promise<ActivityListener> {
	const { config } = deps;
	const prefix = config.rabbitmq.prefix;
	const client = new RabbitMQClient({
		url: source.amqpUrl,
		logger: deps.log.child({ listener: ACTIVITY_EXCHANGE }),
		prefetch: 1
	});
	await client.init();
	const [first = '', ...others] = source.types;
	await client.subscribe(
		ACTIVITY_EXCHANGE,
		first,
		`${prefix}.${ACTIVITY_EXCHANGE}`,
		async (message) => {
			const parsed = activityEventSchema.safeParse(message);
			if (!parsed.success) throw new DeadLetterError('not a CloudEvent of the activity exchange');
			for (const wakeup of wakeupsOf(parsed.data)) await wake(deps, wakeup);
		},
		{
			bindings: others.map((type) => ({ exchange: ACTIVITY_EXCHANGE, routingKey: type })),
			deadLetterExchange: `${prefix}.dlx`,
			queueArguments: { 'x-single-active-consumer': true, 'x-delivery-limit': DELIVERY_LIMIT }
		}
	);
	return { close: () => client.close() };
}
