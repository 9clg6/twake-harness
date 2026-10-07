import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	DeadLetterError,
	RabbitMQClient,
	type RabbitMQMessage,
	type RabbitMQMessageProperties
} from '@linagora/rabbitmq-client';

import type { Config } from '../config.js';
import { isTransient } from '../db/transient.js';
import { brokerLogger, failureOf, logHandled, type Handled } from './logs.js';
import { outcomeOf, type RecipientOutcome } from './outcomes.js';
import { wake, type WakeDeps, type Wakeup } from './wake.js';

// How many times a message may come back before it is dead-lettered, as one that brings the
// worker down whenever it is delivered: set, since RabbitMQ 3.13 has no limit and 4.0 one of 20,
// and fixed once the queue is declared
const DELIVERY_LIMIT = 5;

// The first wait before a message is tried again, doubled after each attempt up to a minute: a
// transient failure, such as the database being down, is tried again for as long as it lasts
const RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60_000;

// How many times a message whose failure is not transient is tried before it goes to the dead
// letter queue, so that the messages behind it go on
const MAX_ATTEMPTS = 5;

// What identifies a message in its line, as far as the listener could read it
export type Identity = Pick<Handled, 'source' | 'eventId' | 'type' | 'recipients'>;

// What a source makes of a message, before anything is written
export type Reading =
	// No event it can read: it goes to the dead letter queue at once, its line saying why
	| { readonly kind: 'malformed'; readonly identity: Identity; readonly reason: string }
	// Taken without effect, its line saying why
	| { readonly kind: 'ignored'; readonly identity: Identity; readonly reason: string }
	// Taken without effect and logged nowhere: a message for another instance, of which the
	// listener keeps nothing
	| { readonly kind: 'foreign' }
	// The wake-ups it brings, and what came of the recipients it left out
	| {
			readonly kind: 'wakeups';
			readonly identity: Identity;
			readonly wakeups: readonly Wakeup[];
			readonly left: readonly RecipientOutcome[];
	  };

// How a source's messages read
export type Read = (message: RabbitMQMessage, properties: RabbitMQMessageProperties) => Reading;

// A queue of the instance's own, which it declares and reads, bound to the exchange of a source
// another service owns
export interface OwnQueue {
	// The broker, the source's vhost included
	readonly url: string;
	// What the queue is named after the instance's prefix, such as activity
	readonly name: string;
	// The source's exchange, which the instance's user may not declare, and the routing keys the
	// queue is bound to there: one, any, for a fanout
	readonly exchange: string;
	readonly routingKeys: readonly string[];
}

export interface Listener {
	// Whether it holds its connection to the broker, as the client knows it without asking the
	// broker: the library's own probe declares a queue of the broker's naming, which the
	// instance's user may not do, and the refusal closes the channel the listener reads on
	connected(): boolean;
	close(): Promise<void>;
}

// The full name of a queue of the instance's own: its prefix keeps any two instances apart
export function ownQueueName(config: Config, name: string): string {
	return `${config.rabbitmq.prefix}.${name}`;
}

// Listens to a source on the instance's own quorum queue: one message at a time and with a single
// active consumer, so that messages keep their order whatever the replicas, a delivery limit, and
// dead letters into the instance's own exchange on the source's vhost, <prefix>.dlx, and queue,
// <queue>.dlq. Each message the source reads wakes the assistant of each recipient it brings, and
// is taken once what it wakes is written. A transient failure is tried again without end and any
// other five times, before the message goes to the dead letter queue; one that is no event goes
// there at once. Each message gives one line, event handled, and no line carries what a message
// says. A broker out of reach or an exchange missing never stops the role: the listener tries
// again without end, the waits doubling up to a minute, and resolves once its first attempt is
// over.
export async function listenOnOwnQueue(
	deps: WakeDeps,
	own: OwnQueue,
	read: Read,
	options: { readonly retryDelayMs?: number } = {}
): Promise<Listener> {
	const log = deps.log.child({ listener: own.name });
	const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
	const queue = ownQueueName(deps.config, own.name);
	const deadLetterExchange = `${deps.config.rabbitmq.prefix}.dlx`;
	// The message whose failures are not transient, by its content, and how many it had: one at a
	// time, since the listener holds one message at a time, and the same after a redelivery
	let failing: { readonly key: string; readonly count: number } | null = null;

	const handle = async (
		message: RabbitMQMessage,
		properties: RabbitMQMessageProperties
	): Promise<void> => {
		let identity: Identity = {};
		const outcomes: RecipientOutcome[] = [];
		try {
			const reading = read(message, properties);
			if (reading.kind === 'foreign') return;
			identity = reading.identity;
			if (reading.kind === 'ignored') {
				logHandled(log, { ...identity, outcome: 'ignored', reason: reading.reason });
				return;
			}
			if (reading.kind === 'malformed') {
				logHandled(log, { ...identity, outcome: 'dead_lettered', reason: reading.reason });
				throw new DeadLetterError(reading.reason);
			}
			outcomes.push(...reading.left);
			for (const wakeup of reading.wakeups) outcomes.push(await wake(deps, wakeup));
		} catch (err: unknown) {
			if (err instanceof DeadLetterError) throw err;
			const transient = isTransient(err);
			log.warn({ ...identity, transient, err: failureOf(err) }, 'event failed');
			if (transient) throw err;
			const key = createHash('sha256').update(JSON.stringify(message)).digest('base64url');
			const count = failing?.key === key ? failing.count + 1 : 1;
			failing = { key, count };
			if (count < MAX_ATTEMPTS) throw err;
			failing = null;
			const reason = `failed ${MAX_ATTEMPTS} times`;
			logHandled(log, { ...identity, outcome: 'dead_lettered', reason });
			throw new DeadLetterError(reason, { cause: err });
		}
		failing = null;
		logHandled(log, { ...identity, ...outcomeOf(outcomes) });
	};
	const stopping = new AbortController();
	let client: RabbitMQClient | null = null;
	let listening = false;

	// The wait after a failed attempt to listen, the first one at least
	const waitAfter = (attempt: number): number =>
		Math.min(retryDelayMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);

	// An attempt to listen, with a client of its own: true once it listens
	async function attempt(count: number): Promise<boolean> {
		const candidate = new RabbitMQClient({
			url: own.url,
			// The library's own lines, without what a message holds, which they would carry at every
			// level, the body of every message it receives at debug included
			logger: brokerLogger(log),
			prefetch: 1,
			retryDelay: retryDelayMs,
			// One connection attempt each time: the listener tries again itself
			initMaxAttempts: 1,
			hooks: {
				// A message that is no JSON never reaches the handler: the library dead-letters it
				onMessageDlq: ({ routingKey, reason }) => {
					if (reason === 'invalid_json') {
						logHandled(log, {
							...(routingKey === '' ? {} : { type: routingKey }),
							outcome: 'dead_lettered',
							reason: 'not JSON'
						});
					}
				},
				// The library connects again by itself once the broker is back, and reads the queue
				// again; when that fails, it leaves the client at that, reading nothing
				onReconnect: ({ subscriptionsFailed }) => {
					if (subscriptionsFailed > 0) listenAgain(candidate);
				}
			}
		});
		client = candidate;
		try {
			await candidate.init();
			// The library binds the queue first to the exchange and key it is given, and keys the
			// queue's dead letters after that key, which a quorum queue keeps as it was declared:
			// bound first to its own dead letter exchange under its own name, the queue keeps the
			// same key whatever routing keys the source is bound by
			await candidate.subscribe(deadLetterExchange, queue, queue, handle, {
				bindings: own.routingKeys.map((routingKey) => ({ exchange: own.exchange, routingKey })),
				deadLetterExchange,
				// The source's service owns its exchange: the library only checks that it is there
				// before it binds
				passiveExchanges: [own.exchange],
				queueArguments: { 'x-single-active-consumer': true, 'x-delivery-limit': DELIVERY_LIMIT },
				maxRetries: Infinity,
				maxRetryDelay: MAX_RETRY_DELAY_MS
			});
			listening = true;
			return true;
		} catch (err: unknown) {
			log.warn(
				{ attempt: count, retryInMs: waitAfter(count), err: failureOf(err) },
				'listen failed'
			);
			// Connected, the client would stay so until the next attempt opens another one
			await candidate.close().catch(() => undefined);
			return false;
		}
	}

	// Tries again after a first attempt failed, until it listens or the role stops
	async function retry(): Promise<void> {
		for (let count = 1; !stopping.signal.aborted; count += 1) {
			await sleep(waitAfter(count), undefined, { signal: stopping.signal }).catch(() => undefined);
			if (stopping.signal.aborted || (await attempt(count + 1))) return;
		}
	}

	// A client that no longer reads the queue is closed, and the listener tries again as at its
	// start
	function listenAgain(failed: RabbitMQClient): void {
		if (stopping.signal.aborted || failed !== client) return;
		listening = false;
		running = (async () => {
			await failed.close().catch(() => undefined);
			await retry();
		})();
	}

	let running = (await attempt(1)) ? Promise.resolve() : retry();
	return {
		connected: () => listening && client?.isConnected() === true,
		close: async () => {
			stopping.abort();
			await running;
			listening = false;
			// With the broker gone, the library fails to close the channel it lost, and logs it: the
			// role stops all the same
			await client?.close().catch(() => undefined);
		}
	};
}
