import type { ILogger } from '@linagora/rabbitmq-client';
import type { FastifyBaseLogger } from 'fastify';

import type { MessageOutcome, RecipientOutcomes } from './outcomes.js';

// The one line a message gives once the listener is done with it: what identifies it, how many
// recipients it names and what came of them, and why it was ignored or dead-lettered, never what
// it says
export interface Handled {
	readonly source?: string;
	readonly eventId?: string;
	readonly type?: string;
	readonly recipients?: number;
	readonly outcome: MessageOutcome;
	// How many of its recipients had each outcome
	readonly outcomes?: RecipientOutcomes;
	readonly reason?: string;
}

export function logHandled(log: FastifyBaseLogger, handled: Handled): void {
	if (handled.outcome === 'dead_lettered') log.error(handled, 'event handled');
	else log.info(handled, 'event handled');
}

// A failure as a log line may say it: its type, code and message, and none of the fields it
// carries, such as the row a database error quotes; a JSON parse error keeps only its type, since
// its message quotes the text it could not read
export function failureOf(err: unknown): Record<string, unknown> | string {
	if (typeof err === 'string') return err;
	if (!(err instanceof Error)) return { type: typeof err };
	if (err instanceof SyntaxError) return { type: err.name };
	const code: unknown = Reflect.get(err, 'code');
	return {
		type: err.name,
		...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
		message: err.message
	};
}

// The fields of the library's lines that a log line may carry: names, counts, delays and
// outcomes, and its failure as failureOf says it. Any other is left out, such as the payload of a
// message, the first characters of a body that is no JSON, and the stack of a failure, which
// quotes its message.
const LIBRARY_FIELDS: ReadonlySet<string> = new Set([
	'exchange',
	'routingKey',
	'queue',
	'queues',
	'bindings',
	'prefetch',
	'count',
	'attempt',
	'attempts',
	'maxAttempts',
	'maxRetries',
	'retryDelayMs',
	'duration',
	'inflightCount',
	'messageSize',
	'action',
	'subscriptionsRestored',
	'subscriptionsFailed'
]);

// The library's own lines that the listener's say better: about a message, and about the one
// connection attempt the listener lets it make each time, which reads as giving up
const RESTATED: ReadonlySet<string> = new Set([
	'Message processed successfully',
	'Handler failed',
	'Handler dead-lettered the message',
	'Failed to parse message JSON, sending to DLQ',
	'Connection failed after maximum attempts'
]);

type Level = 'debug' | 'info' | 'warn' | 'error';

function fieldsOf(context: unknown): Record<string, unknown> {
	if (typeof context !== 'object' || context === null) return {};
	const fields: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(context)) {
		if (key === 'error') fields['err'] = failureOf(value);
		else if (LIBRARY_FIELDS.has(key)) fields[key] = value;
	}
	return fields;
}

// The logger the RabbitMQ library writes through: its lines keep the fields of their context a
// log line may carry, at every level, and those the listener's own lines restate go to debug
export function brokerLogger(log: FastifyBaseLogger): ILogger {
	const write =
		(level: Level) =>
		(message: string, context?: unknown): void => {
			log[RESTATED.has(message) ? 'debug' : level](fieldsOf(context), message);
		};
	return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
