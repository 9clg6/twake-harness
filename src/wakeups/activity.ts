import { DeadLetterError, RabbitMQClient } from '@linagora/rabbitmq-client';
import { z } from 'zod';

import type { ActivitySource } from '../config.js';
import { wake, type WakeDeps, type Wakeup } from './wake.js';

// Where the applications publish what happens to people, as CloudEvents routed by their type
const ACTIVITY_EXCHANGE = 'activity';

// How many times a message may come back before it is dead-lettered, as one that brings the
// worker down whenever it is delivered: set, since RabbitMQ 3.13 has no limit and 4.0 one of 20,
// and fixed once the queue is declared
export const DELIVERY_LIMIT = 5;

// The most recipients of one event the listener reads, in their order: the others are left out
const MAX_RECIPIENTS = 100;

// Text people wrote, cut to its first characters rather than refused, as the contracts cap theirs:
// it is shown as data anyway
function untrustedText(max: number) {
	return z.string().transform((text) => Array.from(text).slice(0, max).join(''));
}

// Someone an event is for, as its application names them
const recipientSchema = z.object({
	uuid: z.uuid().optional(),
	email: z.email().optional(),
	// Any reason the application gives, such as assigned
	reason: z.string().min(1).max(100)
});

// A field the event may leave out: one the application got wrong is left out too, rather than the
// event refused
function optional<T extends z.ZodType>(schema: T) {
	return schema.optional().catch(undefined);
}

// A CloudEvent 1.0 in structured JSON, as ADR 001 and 006 shape them: what its object is, and the
// people it is for. Only an event without its id, source, type or object goes to the dead letter
// queue.
const activityEventSchema = z.object({
	specversion: z.literal('1.0'),
	id: z.string().min(1).max(200),
	source: z.string().min(1).max(200),
	type: z.string().min(1).max(200),
	time: optional(z.iso.datetime({ offset: true })),
	twakeorg: optional(z.string().min(1).max(200)),
	twakeactor: optional(z.email()),
	twakeactorid: optional(z.uuid()),
	data: z.object({
		object: z.object({
			type: z.string().min(1).max(100),
			id: z.string().min(1).max(200),
			title: optional(untrustedText(1000)),
			key: optional(z.string().min(1).max(100)),
			board: optional(z.object({ id: z.string().min(1).max(200), name: untrustedText(200) })),
			container: optional(
				z.object({ kind: z.string().min(1).max(100), id: z.string().min(1).max(200) })
			),
			url: optional(z.url({ protocol: /^https?$/ }).max(2000))
		}),
		// A plain text excerpt of the object, which ADR 006 caps at 280 characters
		preview: optional(untrustedText(1000)),
		// Exactly who the event is for, nobody inferred, each read on its own: one the application
		// names wrongly takes nobody else's turn away
		recipients: optional(z.array(z.unknown()))
	})
});

// The optional fields of an event, by their path
const OPTIONAL_FIELDS: readonly (readonly string[])[] = [
	['time'],
	['twakeorg'],
	['twakeactor'],
	['twakeactorid'],
	['data', 'object', 'title'],
	['data', 'object', 'key'],
	['data', 'object', 'board'],
	['data', 'object', 'container'],
	['data', 'object', 'url'],
	['data', 'preview'],
	['data', 'recipients']
];

function valueAt(value: unknown, path: readonly string[]): unknown {
	let at: unknown = value;
	for (const key of path) {
		if (typeof at !== 'object' || at === null) return undefined;
		at = (at as Record<string, unknown>)[key];
	}
	return at;
}

// The optional fields the application sent that were left out, as it got them wrong
function leftOutFields(message: unknown, event: ActivityEvent): string[] {
	return OPTIONAL_FIELDS.filter(
		(path) => valueAt(message, path) !== undefined && valueAt(event, path) === undefined
	).map((path) => path.join('.'));
}

type ActivityEvent = z.infer<typeof activityEventSchema>;

// A recipient left out, by their place among the event's recipients and the names of the fields
// the application got wrong: never what it wrote there
interface SkippedRecipient {
	readonly index: number;
	readonly fields: readonly string[];
}

// One wake-up per recipient. What the application computed (its ids, key, link and time, and who
// acted) is shown apart from what people wrote (the title, the board's name and the preview), as
// the contracts return it under untrusted.
function wakeupsOf(event: ActivityEvent): {
	readonly wakeups: Wakeup[];
	readonly skipped: SkippedRecipient[];
	// How many recipients past the most it reads
	readonly ignored: number;
} {
	const { object, preview } = event.data;
	const computedObject = {
		type: object.type,
		id: object.id,
		...(object.key === undefined ? {} : { key: object.key }),
		...(object.board === undefined ? {} : { board_id: object.board.id }),
		...(object.container === undefined ? {} : { container: object.container }),
		...(object.url === undefined ? {} : { url: object.url })
	};
	const untrusted = {
		...(object.title === undefined ? {} : { title: object.title }),
		...(object.board === undefined ? {} : { board_name: object.board.name }),
		...(preview === undefined ? {} : { preview })
	};
	const wakeups: Wakeup[] = [];
	const skipped: SkippedRecipient[] = [];
	const recipients = event.data.recipients ?? [];
	recipients.slice(0, MAX_RECIPIENTS).forEach((named, index) => {
		const parsed = recipientSchema.safeParse(named);
		if (!parsed.success) {
			const fields = parsed.error.issues.map((issue) => String(issue.path[0] ?? 'recipient'));
			skipped.push({ index, fields: [...new Set(fields)] });
			return;
		}
		const recipient = parsed.data;
		wakeups.push({
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
		});
	});
	return {
		wakeups,
		skipped,
		ignored: Math.max(0, recipients.length - MAX_RECIPIENTS)
	};
}

export interface ActivityListener {
	// Whether it holds its connection to the broker, as the client knows it without asking the
	// broker: the library's own probe declares a queue of the broker's naming, which the
	// instance's user may not do, and the refusal closes the channel the listener reads on
	connected(): boolean;
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
	const queue = `${prefix}.${ACTIVITY_EXCHANGE}`;
	const deadLetterExchange = `${prefix}.dlx`;
	// The library binds the queue first to the exchange and key it is given, and keys the queue's
	// dead letters after that key, which a quorum queue keeps as it was declared: bound first to its
	// own dead letter exchange under its own name, the queue keeps the same key whatever types the
	// deployment lists, and is bound to the activity exchange for those types alone
	await client.subscribe(
		deadLetterExchange,
		queue,
		queue,
		async (message, { routingKey }) => {
			// A type the deployment no longer lists keeps its binding, since the library removes none:
			// its events are taken and dropped. An event comes by the queue's own name when its dead
			// letters are moved back into it.
			if (routingKey !== queue && !source.types.includes(routingKey)) return;
			const parsed = activityEventSchema.safeParse(message);
			if (!parsed.success) throw new DeadLetterError('not a CloudEvent of the activity exchange');
			const event = parsed.data;
			const fields = leftOutFields(message, event);
			if (fields.length > 0) {
				deps.log.warn({ source: event.source, eventId: event.id, fields }, 'event fields left out');
			}
			const { wakeups, skipped, ignored } = wakeupsOf(event);
			if (ignored > 0) {
				deps.log.warn({ source: event.source, eventId: event.id, ignored }, 'recipients ignored');
			}
			for (const { index, fields } of skipped) {
				deps.log.warn(
					{ source: event.source, eventId: event.id, recipient: index, fields },
					'recipient skipped'
				);
			}
			for (const wakeup of wakeups) await wake(deps, wakeup);
		},
		{
			bindings: source.types.map((type) => ({ exchange: ACTIVITY_EXCHANGE, routingKey: type })),
			deadLetterExchange,
			// The platform owns the exchange: its RabbitMQ user may not declare it, and the library
			// only checks that it is there before it binds
			passiveExchanges: [ACTIVITY_EXCHANGE],
			queueArguments: { 'x-single-active-consumer': true, 'x-delivery-limit': DELIVERY_LIMIT }
		}
	);
	return { connected: () => client.isConnected(), close: () => client.close() };
}
