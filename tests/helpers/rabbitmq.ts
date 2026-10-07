import { RabbitMQContainer, type StartedRabbitMQContainer } from '@testcontainers/rabbitmq';
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';

// The broker of the platform, RabbitMQ 3.13 as on dev, from Google's public mirror of Docker Hub:
// anonymous pulls from Docker Hub hit its rate limit on the organization's runners
const IMAGE = process.env['RABBITMQ_IMAGE'] ?? 'mirror.gcr.io/library/rabbitmq:3.13';

// Twice the tick of a quorum queue, on which the broker counts the queue's messages
const COUNTED_WITHIN_MS = 10_000;

// What a user may do on a vhost, each a regular expression over the names of exchanges and queues
export interface Permissions {
	readonly configure: string;
	readonly write: string;
	readonly read: string;
}

// An exchange routing to a queue, and the key it routes on
export interface Binding {
	readonly source: string;
	readonly routingKey: string;
}

export interface QueueState {
	readonly type: string;
	readonly arguments: Readonly<Record<string, unknown>>;
	// Ready and unacknowledged
	readonly messages: number;
}

export interface TestBroker {
	// The platform's own channel, with every right: what sets the broker up and publishes on it
	readonly channel: ConfirmChannel;
	// The address of the broker for one of its users, on the default vhost
	urlFor(user: string, password: string): string;
	addUser(user: string, password: string, permissions: Permissions): Promise<void>;
	// What routes to a queue, but the default exchange, which routes to every queue by its name
	bindingsOf(queue: string): Promise<Binding[]>;
	queue(name: string): Promise<QueueState | null>;
	// Resolves once the broker counts that many messages in a queue. It counts those of a quorum
	// queue on the queue's tick, every five seconds, so a message settled a moment ago may still be
	// counted; and a dead letter until its dead letter queue takes it, so once a quorum queue is
	// counted empty, its dead letter queue holds every message dead-lettered from it.
	waitForMessages(name: string, count: number): Promise<void>;
	// How many messages each consumer of a queue may hold unacknowledged
	prefetchOf(queue: string): Promise<number[]>;
	// The user of each connection open, one entry per connection
	connectedUsers(): Promise<string[]>;
	// Publishes as an application does, persistent and under its id, once the broker took it
	publish(exchange: string, routingKey: string, body: unknown, messageId?: string): Promise<void>;
	stop(): Promise<void>;
}

export async function startTestBroker(): Promise<TestBroker> {
	const container: StartedRabbitMQContainer = await new RabbitMQContainer(IMAGE).start();
	const admin: ChannelModel = await connect(container.getAmqpUrl());
	const channel = await admin.createConfirmChannel();

	async function rabbitmqctl(...args: string[]): Promise<string> {
		const result = await container.exec(['rabbitmqctl', '-q', ...args]);
		if (result.exitCode !== 0) {
			throw new Error(`rabbitmqctl ${args.join(' ')} failed: ${result.output}`);
		}
		return result.stdout;
	}

	async function listed<T>(...args: string[]): Promise<T[]> {
		return JSON.parse(await rabbitmqctl(...args, '--formatter', 'json')) as T[];
	}

	async function stateOf(name: string): Promise<QueueState | null> {
		const rows = await listed<{
			name: string;
			type: string;
			arguments: [string, string, unknown][];
			messages: number;
		}>('list_queues', 'name', 'type', 'arguments', 'messages');
		const row = rows.find((candidate) => candidate.name === name);
		if (row === undefined) return null;
		return {
			type: row.type,
			arguments: Object.fromEntries(row.arguments.map(([key, , value]) => [key, value])),
			messages: row.messages
		};
	}

	return {
		channel,
		urlFor: (user, password) =>
			`amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${container.getHost()}:${container.getMappedPort(5672)}`,
		addUser: async (user, password, permissions) => {
			await rabbitmqctl('add_user', user, password);
			await rabbitmqctl(
				'set_permissions',
				'-p',
				'/',
				user,
				permissions.configure,
				permissions.write,
				permissions.read
			);
		},
		bindingsOf: async (queue) => {
			const rows = await listed<{
				source_name: string;
				destination_name: string;
				routing_key: string;
			}>('list_bindings', 'source_name', 'destination_name', 'routing_key');
			return rows
				.filter((row) => row.destination_name === queue && row.source_name !== '')
				.map((row) => ({ source: row.source_name, routingKey: row.routing_key }));
		},
		queue: stateOf,
		waitForMessages: async (name, count) => {
			const deadline = Date.now() + COUNTED_WITHIN_MS;
			let counted = (await stateOf(name))?.messages;
			while (counted !== count && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 250));
				counted = (await stateOf(name))?.messages;
			}
			if (counted === undefined) throw new Error(`the broker has no queue ${name}`);
			if (counted !== count) {
				throw new Error(
					`the broker still counts ${counted} messages in ${name} after ${COUNTED_WITHIN_MS / 1000} s, not ${count}`
				);
			}
		},
		prefetchOf: async (queue) =>
			(
				await listed<{ queue_name: string; prefetch_count: number }>(
					'list_consumers',
					'queue_name',
					'prefetch_count'
				)
			)
				.filter((row) => row.queue_name === queue)
				.map((row) => row.prefetch_count),
		connectedUsers: async () =>
			(await listed<{ user: string }>('list_connections', 'user')).map((row) => row.user),
		publish: async (exchange, routingKey, body, messageId) => {
			channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(body)), {
				persistent: true,
				contentType: 'application/cloudevents+json',
				...(messageId === undefined ? {} : { messageId })
			});
			await channel.waitForConfirms();
		},
		stop: async () => {
			await channel.close();
			await admin.close();
			await container.stop();
		}
	};
}
