import type { RabbitMQMessage, RabbitMQMessageProperties } from '@linagora/rabbitmq-client';
import { z } from 'zod';

import type { ActivitySource } from '../config.js';
import type { Noted } from '../journal/repository.js';
import { cut } from '../llm/data.js';
import {
	listenOnOwnQueue,
	ownQueueName,
	type Identity,
	type Listener,
	type Reading
} from './listener.js';
import type { RecipientOutcome } from './outcomes.js';
import type { WakeDeps, Wakeup } from './wake.js';

// Where the applications publish what happens to people, as CloudEvents routed by their type
const ACTIVITY_EXCHANGE = 'activity';

// The most recipients of one event the listener reads, in their order: the others are left out
const MAX_RECIPIENTS = 100;

// The objects whose title the listening journal keeps: a task's or a meeting's, never what a
// message or a file is called
const TITLED_OBJECTS: readonly string[] = ['task', 'event'];

// Text people wrote, cut rather than refused
function untrustedText(max: number) {
	return z.string().transform((text) => cut(text, max));
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

// The attributes that identify an event, as far as a message the listener does not read has them
const IDENTITY = { source: 'source', eventId: 'id', type: 'type' } as const;

function identityOf(message: unknown, routingKey: string): Identity {
	const identity: { source?: string; eventId?: string; type?: string; recipients?: number } = {
		type: routingKey
	};
	for (const [field, attribute] of Object.entries(IDENTITY)) {
		const value = valueAt(message, [attribute]);
		if (typeof value === 'string' && value.length > 0 && value.length <= 200) {
			identity[field as keyof typeof IDENTITY] = value;
		}
	}
	const recipients = valueAt(message, ['data', 'recipients']);
	if (Array.isArray(recipients)) identity.recipients = recipients.length;
	return identity;
}

// Why a message is no event of the activity exchange: the attribute at fault, never its value
function malformedReason(message: unknown, error: z.ZodError): string {
	const path = (error.issues[0]?.path ?? []).map(String);
	if (path.length === 0) return 'not a CloudEvent';
	return `${valueAt(message, path) === undefined ? 'no' : 'invalid'} ${path.join('.')}`;
}

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
	// What identifies the object to act on it
	const objectIds = {
		type: object.type,
		id: object.id,
		...(object.key === undefined ? {} : { key: object.key })
	};
	const computedObject = {
		...objectIds,
		...(object.board === undefined ? {} : { board_id: object.board.id }),
		...(object.container === undefined ? {} : { container: object.container }),
		...(object.url === undefined ? {} : { url: object.url })
	};
	const untrusted = {
		...(object.title === undefined ? {} : { title: object.title }),
		...(object.board === undefined ? {} : { board_name: object.board.name }),
		...(preview === undefined ? {} : { preview })
	};
	// What the owner's listening journal keeps of it: the object, by what identifies it to act on
	// it, and the title of a task or a meeting alone
	const noted: Noted = {
		ids: { computed: { object: objectIds }, untrusted: {} },
		names: {
			computed: {},
			untrusted:
				object.title !== undefined && TITLED_OBJECTS.includes(object.type)
					? { title: object.title }
					: {}
		}
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
			},
			noted
		});
	});
	return {
		wakeups,
		skipped,
		ignored: Math.max(0, recipients.length - MAX_RECIPIENTS)
	};
}

// Listens to the activity exchange on the instance's own queue, bound to the types the deployment
// lists alone, and wakes the assistant of each recipient of an event
export function startActivityListener(
	deps: WakeDeps,
	source: ActivitySource,
	options: { readonly retryDelayMs?: number } = {}
): Listener {
	const queue = ownQueueName(deps.config, ACTIVITY_EXCHANGE);
	const read = (message: RabbitMQMessage, { routingKey }: RabbitMQMessageProperties): Reading => {
		// A type the deployment no longer lists keeps its binding, since the library removes none:
		// its events are taken and dropped. An event comes by the queue's own name when its dead
		// letters are moved back into it.
		if (routingKey !== queue && !source.types.includes(routingKey)) {
			return {
				kind: 'ignored',
				identity: identityOf(message, routingKey),
				reason: 'type not listened to'
			};
		}
		const parsed = activityEventSchema.safeParse(message);
		if (!parsed.success) {
			return {
				kind: 'malformed',
				identity: identityOf(message, routingKey),
				reason: malformedReason(message, parsed.error)
			};
		}
		const event = parsed.data;
		const identity: Identity = {
			source: event.source,
			eventId: event.id,
			type: event.type,
			recipients: (event.data.recipients ?? []).length
		};
		const fields = leftOutFields(message, event);
		if (fields.length > 0) deps.log.warn({ ...identity, fields }, 'event fields left out');
		const { wakeups, skipped, ignored } = wakeupsOf(event);
		if (ignored > 0) deps.log.warn({ ...identity, ignored }, 'recipients ignored');
		for (const { index, fields } of skipped) {
			deps.log.warn({ ...identity, recipient: index, fields }, 'recipient skipped');
		}
		return {
			kind: 'wakeups',
			identity,
			wakeups,
			// Those left out count among the recipients of the event: past the most it reads, as
			// ignored, and those it cannot read, as invalid
			leftOut: [
				...skipped.map((): RecipientOutcome => 'invalid'),
				...Array.from({ length: ignored }, (): RecipientOutcome => 'ignored')
			]
		};
	};
	return listenOnOwnQueue(
		deps,
		{
			url: source.amqpUrl,
			name: ACTIVITY_EXCHANGE,
			exchange: ACTIVITY_EXCHANGE,
			routingKeys: source.types
		},
		read,
		options
	);
}
