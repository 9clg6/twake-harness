import { RabbitMQClient, type RabbitMQMessageHandler } from '@linagora/rabbitmq-client';

import type { Config } from '../config.js';
import { brokerLogger, logHandled } from './logs.js';
import type { WakeDeps } from './wake.js';

// How many times a message may come back before it is dead-lettered, as one that brings the
// worker down whenever it is delivered: set, since RabbitMQ 3.13 has no limit and 4.0 one of 20,
// and fixed once the queue is declared
const DELIVERY_LIMIT = 5;

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
// <queue>.dlq. A message is taken once its handler returns.
export async function listenOnOwnQueue(
	deps: WakeDeps,
	own: OwnQueue,
	handle: RabbitMQMessageHandler
): Promise<Listener> {
	const log = deps.log.child({ listener: own.name });
	const client = new RabbitMQClient({
		url: own.url,
		// The library's own lines, without what a message holds, which they would carry at every
		// level, the body of every message it receives at debug included
		logger: brokerLogger(log),
		prefetch: 1,
		hooks: {
			// A message that is no JSON never reaches the handler: the library dead-letters it
			onMessageDlq: ({ routingKey, reason }) => {
				if (reason === 'invalid_json') {
					logHandled(log, { type: routingKey, outcome: 'dead_lettered', reason: 'not JSON' });
				}
			}
		}
	});
	await client.init();
	const queue = ownQueueName(deps.config, own.name);
	const deadLetterExchange = `${deps.config.rabbitmq.prefix}.dlx`;
	// The library binds the queue first to the exchange and key it is given, and keys the queue's
	// dead letters after that key, which a quorum queue keeps as it was declared: bound first to its
	// own dead letter exchange under its own name, the queue keeps the same key whatever routing
	// keys the source is bound by
	await client.subscribe(deadLetterExchange, queue, queue, handle, {
		bindings: own.routingKeys.map((routingKey) => ({ exchange: own.exchange, routingKey })),
		deadLetterExchange,
		// The source's service owns its exchange: the library only checks that it is there before
		// it binds
		passiveExchanges: [own.exchange],
		queueArguments: { 'x-single-active-consumer': true, 'x-delivery-limit': DELIVERY_LIMIT }
	});
	return { connected: () => client.isConnected(), close: () => client.close() };
}
