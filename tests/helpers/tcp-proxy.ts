import { connect, createServer, type Socket } from 'node:net';

// Where a proxy forwards the connections it takes, looked up for each one
export interface Upstream {
	readonly host: string;
	readonly port: number;
}

// The port of an address that names none, by its scheme
const DEFAULT_PORTS: Readonly<Record<string, number>> = { 'postgres:': 5432, 'amqp:': 5672 };

// The server an address points to, such as a database's or a broker's URL
export function upstreamOf(url: string): Upstream {
	const { hostname, port, protocol } = new URL(url);
	return { host: hostname, port: port === '' ? (DEFAULT_PORTS[protocol] ?? 0) : Number(port) };
}

// A server between a role and one it depends on, such as its database or its broker, that the
// test can take down and bring back while the role runs
export interface TcpProxy {
	readonly port: number;
	// An address of the upstream server, such as its URL with a user and a database, through the
	// proxy instead
	through(url: string): string;
	// Drops every connection through it, and refuses the next ones, as a server gone down
	cut(): void;
	restore(): void;
	close(): Promise<void>;
}

export async function startTcpProxy(upstream: () => Upstream): Promise<TcpProxy> {
	let up = true;
	const sockets = new Set<Socket>();
	const server = createServer((client) => {
		if (!up) {
			client.resetAndDestroy();
			return;
		}
		const { host, port } = upstream();
		// The connection on to the upstream server, carrying what the client sends and back
		const onward = connect(port, host);
		for (const socket of [client, onward]) {
			sockets.add(socket);
			socket.on('error', () => undefined);
			socket.on('close', () => {
				sockets.delete(socket);
				client.destroy();
				onward.destroy();
			});
		}
		client.pipe(onward);
		onward.pipe(client);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('the proxy has no port');
	const dropAll = (): void => {
		for (const socket of sockets) socket.resetAndDestroy();
	};
	const { port } = address;
	return {
		port,
		through: (url) => {
			const proxied = new URL(url);
			proxied.hostname = '127.0.0.1';
			proxied.port = String(port);
			return proxied.toString();
		},
		cut: () => {
			up = false;
			dropAll();
		},
		restore: () => {
			up = true;
		},
		close: async () => {
			up = false;
			dropAll();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	};
}

// A server that takes connections and never says a word, as a broker behind a firewall that
// drops what it sends back
export interface SilentServer {
	readonly port: number;
	// The connections it holds open now
	connections(): number;
	close(): Promise<void>;
}

export async function startSilentServer(): Promise<SilentServer> {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on('error', () => undefined);
		socket.on('close', () => sockets.delete(socket));
		// Reads what it is sent and drops it: unread, the end of a connection would never come
		socket.resume();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('the server has no port');
	return {
		port: address.port,
		connections: () => sockets.size,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	};
}
