import type { ILogger } from '@linagora/rabbitmq-client';
import type { FastifyBaseLogger } from 'fastify';

import type { WakeOutcome } from './wake.js';

// What came of a message: what came of its recipients, or its dead lettering
export type MessageOutcome = WakeOutcome | 'dead_lettered';

// What came of one recipient: a wake-up's outcome, or invalid for a recipient named in a shape
// the listener cannot read, which it skips
export type RecipientOutcome = WakeOutcome | 'invalid';

// The outcome of a message is the first of these that one of its recipients had, the one the
// operator most needs to see; a recipient that cannot be read counts as ignored. Every outcome of
// a wake-up has its place here, and a new one compiles once it has: one that holds back a turn
// due, such as a cap on an owner's wake-ups, comes right after woken.
const PRECEDENCE: Readonly<Record<WakeOutcome, number>> = {
	woken: 0,
	capped: 1,
	duplicate: 2,
	no_assistant: 3,
	ignored: 4
};

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
	readonly outcomes?: Readonly<Partial<Record<RecipientOutcome, number>>>;
	readonly reason?: string;
}

export function logHandled(log: FastifyBaseLogger, handled: Handled): void {
	if (handled.outcome === 'dead_lettered') log.error(handled, 'event handled');
	else log.info(handled, 'event handled');
}

// The outcome of a message from those of its recipients, ignored when it names nobody, and how
// many had each
export function outcomeOf(
	recipients: readonly RecipientOutcome[]
): Required<Pick<Handled, 'outcome' | 'outcomes'>> {
	const outcomes: Partial<Record<RecipientOutcome, number>> = {};
	let outcome: WakeOutcome = 'ignored';
	for (const recipient of recipients) {
		outcomes[recipient] = (outcomes[recipient] ?? 0) + 1;
		const counted = recipient === 'invalid' ? 'ignored' : recipient;
		if (PRECEDENCE[counted] < PRECEDENCE[outcome]) outcome = counted;
	}
	return { outcome, outcomes };
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

// The fields under which the library logs what a message holds
const CONTENT_FIELDS: ReadonlySet<string> = new Set(['payload', 'rawContentPreview']);

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
		if (CONTENT_FIELDS.has(key)) continue;
		if (key === 'error') fields['err'] = failureOf(value);
		else fields[key] = value;
	}
	return fields;
}

// The logger the RabbitMQ library writes through: its lines keep their context but for what a
// message holds, which no line carries at any level, and those the listener's own lines restate
// go to debug
export function brokerLogger(log: FastifyBaseLogger): ILogger {
	const write =
		(level: Level) =>
		(message: string, context?: unknown): void => {
			log[RESTATED.has(message) ? 'debug' : level](fieldsOf(context), message);
		};
	return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
