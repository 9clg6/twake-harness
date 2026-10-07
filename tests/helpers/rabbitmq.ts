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

// A vhost of the broker other than the default one, as the platform sets it up for an application
// such as Calendar
export interface TestVhost {
	// The platform's own channel on it, with every right
	readonly channel: ConfirmChannel;
	// The address of the broker for one of its users, on this vhost
	urlFor(user: string, password: string): string;
	// Lets a user of the broker do this much on this vhost
	allow(user: string, permissions: Permissions): Promise<void>;
	bindingsOf(queue: string): Promise<Binding[]>;
	queue(name: string): Promise<QueueState | null>;
	// As the broker's own, on this vhost
	waitForMessages(name: string, count: number): Promise<void>;
	prefetchOf(queue: string): Promise<number[]>;
	// The user of each connection open on this vhost, one entry per connection
	connectedUsers(): Promise<string[]>;
	// Publishes as an application's own service does, persistent JSON, once the broker took it
	publish(exchange: string, routingKey: string, body: unknown): Promise<void>;
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
	// Creates a vhost, which the platform's own user may do everything on
	addVhost(name: string): Promise<TestVhost>;
	stop(): Promise<void>;
}

export async function startTestBroker(): Promise<TestBroker> {
	const container: StartedRabbitMQContainer = await new RabbitMQContainer(IMAGE).start();
	const admin: ChannelModel = await connect(container.getAmqpUrl());
	const channel = await admin.createConfirmChannel();
	// The platform's own connections to the other vhosts, closed with the broker
	const vhosts: ChannelModel[] = [];

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

	// The address of the broker for one of its users, on the default vhost or on another one
	function urlOn(vhost: string, user: string, password: string): string {
		const path = vhost === '/' ? '' : `/${encodeURIComponent(vhost)}`;
		return `amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${container.getHost()}:${container.getMappedPort(5672)}${path}`;
	}

	async function allowOn(vhost: string, user: string, permissions: Permissions): Promise<void> {
		await rabbitmqctl(
			'set_permissions',
			'-p',
			vhost,
			user,
			permissions.configure,
			permissions.write,
			permissions.read
		);
	}

	async function bindingsOn(vhost: string, queue: string): Promise<Binding[]> {
		const rows = await listed<{
			source_name: string;
			destination_name: string;
			routing_key: string;
		}>('list_bindings', '-p', vhost, 'source_name', 'destination_name', 'routing_key');
		return rows
			.filter((row) => row.destination_name === queue && row.source_name !== '')
			.map((row) => ({ source: row.source_name, routingKey: row.routing_key }));
	}

	async function queueOn(vhost: string, name: string): Promise<QueueState | null> {
		const rows = await listed<{
			name: string;
			type: string;
			arguments: [string, string, unknown][];
			messages: number;
		}>('list_queues', '-p', vhost, 'name', 'type', 'arguments', 'messages');
		const row = rows.find((candidate) => candidate.name === name);
		if (row === undefined) return null;
		return {
			type: row.type,
			arguments: Object.fromEntries(row.arguments.map(([key, , value]) => [key, value])),
			messages: row.messages
		};
	}

	// Resolves once the broker counts that many messages in a queue of a vhost
	async function messagesOn(vhost: string, name: string, count: number): Promise<void> {
		const deadline = Date.now() + COUNTED_WITHIN_MS;
		let counted = (await queueOn(vhost, name))?.messages;
		while (counted !== count && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			counted = (await queueOn(vhost, name))?.messages;
		}
		if (counted === undefined) throw new Error(`the broker has no queue ${name}`);
		if (counted !== count) {
			throw new Error(
				`the broker still counts ${counted} messages in ${name} after ${COUNTED_WITHIN_MS / 1000} s, not ${count}`
			);
		}
	}

	async function prefetchOn(vhost: string, queue: string): Promise<number[]> {
		return (
			await listed<{ queue_name: string; prefetch_count: number }>(
				'list_consumers',
				'-p',
				vhost,
				'queue_name',
				'prefetch_count'
			)
		)
			.filter((row) => row.queue_name === queue)
			.map((row) => row.prefetch_count);
	}

	async function connectionsOf(): Promise<{ user: string; vhost: string }[]> {
		return listed<{ user: string; vhost: string }>('list_connections', 'user', 'vhost');
	}

	return {
		channel,
		urlFor: (user, password) => urlOn('/', user, password),
		addUser: async (user, password, permissions) => {
			await rabbitmqctl('add_user', user, password);
			await allowOn('/', user, permissions);
		},
		bindingsOf: (queue) => bindingsOn('/', queue),
		queue: (name) => queueOn('/', name),
		waitForMessages: (name, count) => messagesOn('/', name, count),
		prefetchOf: (queue) => prefetchOn('/', queue),
		connectedUsers: async () => (await connectionsOf()).map((row) => row.user),
		publish: async (exchange, routingKey, body, messageId) => {
			channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(body)), {
				persistent: true,
				contentType: 'application/cloudevents+json',
				...(messageId === undefined ? {} : { messageId })
			});
			await channel.waitForConfirms();
		},
		addVhost: async (name) => {
			await rabbitmqctl('add_vhost', name);
			// The default user the platform's channel connects as, which a new vhost grants nothing
			await allowOn(name, 'guest', { configure: '.*', write: '.*', read: '.*' });
			const connection = await connect(urlOn(name, 'guest', 'guest'));
			const vhostChannel = await connection.createConfirmChannel();
			vhosts.push(connection);
			return {
				channel: vhostChannel,
				urlFor: (user, password) => urlOn(name, user, password),
				allow: (user, permissions) => allowOn(name, user, permissions),
				bindingsOf: (queue) => bindingsOn(name, queue),
				queue: (queue) => queueOn(name, queue),
				waitForMessages: (queue, count) => messagesOn(name, queue, count),
				prefetchOf: (queue) => prefetchOn(name, queue),
				connectedUsers: async () =>
					(await connectionsOf()).filter((row) => row.vhost === name).map((row) => row.user),
				publish: async (exchange, routingKey, body) => {
					vhostChannel.publish(exchange, routingKey, Buffer.from(JSON.stringify(body)), {
						persistent: true,
						contentType: 'application/json'
					});
					await vhostChannel.waitForConfirms();
				}
			};
		},
		stop: async () => {
			for (const connection of vhosts) await connection.close();
			await channel.close();
			await admin.close();
			await container.stop();
		}
	};
}
