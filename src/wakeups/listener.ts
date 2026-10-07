import { setTimeout as sleep } from 'node:timers/promises';
import { RabbitMQClient, type RabbitMQMessageHandler } from '@linagora/rabbitmq-client';

import type { Config } from '../config.js';
import { brokerLogger, failureOf, logHandled } from './logs.js';
import type { WakeDeps } from './wake.js';

// How many times a message may come back before it is dead-lettered, as one that brings the
// worker down whenever it is delivered: set, since RabbitMQ 3.13 has no limit and 4.0 one of 20,
// and fixed once the queue is declared
const DELIVERY_LIMIT = 5;

// The first wait before a message is tried again, doubled after each attempt up to a minute: a
// transient failure, such as the database being down, is tried again for as long as it lasts
const RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60_000;

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
// <queue>.dlq. A message is taken once its handler returns. A broker out of reach or an exchange
// missing never stops the role: the listener tries again without end, the waits doubling up to a
// minute, and resolves once its first attempt is over.
export async function listenOnOwnQueue(
	deps: WakeDeps,
	own: OwnQueue,
	handle: RabbitMQMessageHandler,
	options: { readonly retryDelayMs?: number } = {}
): Promise<Listener> {
	const log = deps.log.child({ listener: own.name });
	const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
	const queue = ownQueueName(deps.config, own.name);
	const deadLetterExchange = `${deps.config.rabbitmq.prefix}.dlx`;
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
						logHandled(log, { type: routingKey, outcome: 'dead_lettered', reason: 'not JSON' });
					}
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

	const running = (await attempt(1)) ? Promise.resolve() : retry();
	return {
		connected: () => listening && client?.isConnected() === true,
		close: async () => {
			stopping.abort();
			await running;
			listening = false;
			await client?.close();
		}
	};
}
