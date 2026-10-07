import { createRequire } from 'node:module';

// How long a connection to the broker has to open, unless its address says otherwise
const CONNECT_TIMEOUT_MS = 10_000;

type Connect = (
	url: unknown,
	socketOptions?: Readonly<Record<string, unknown>>
) => Promise<unknown>;

interface Amqplib {
	connect: Connect;
	timed?: true;
}

// The time a connection has to open: connection_timeout in the query of its address, in
// milliseconds, as RabbitMQ's URI spec names it, or ten seconds
function connectTimeoutOf(url: unknown): number {
	if (typeof url !== 'string' || !URL.canParse(url)) return CONNECT_TIMEOUT_MS;
	const timeout = Number(new URL(url).searchParams.get('connection_timeout'));
	return Number.isInteger(timeout) && timeout > 0 ? timeout : CONNECT_TIMEOUT_MS;
}

// The RabbitMQ library opens its connections through its own amqplib without a timeout, and lets
// nobody give one: a broker behind a firewall that drops packets holds a connection for minutes,
// until the system gives up. Each connection the library opens, at the listener's start as when
// it connects again by itself, gets a timeout, which amqplib takes from its socket options.
export function timeLibraryConnections(): void {
	const library = createRequire(import.meta.url).resolve('@linagora/rabbitmq-client');
	const amqplib = createRequire(library)('amqplib') as Amqplib;
	if (amqplib.timed === true) return;
	const connect = amqplib.connect;
	amqplib.connect = (url, socketOptions = {}) =>
		connect(url, { timeout: connectTimeoutOf(url), ...socketOptions });
	amqplib.timed = true;
}
