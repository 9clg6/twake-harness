import { connect, createServer, type Socket } from 'node:net';

// Where a proxy forwards the connections it takes, looked up for each one
export interface Upstream {
	readonly host: string;
	readonly port: number;
}

// A server between a role and one it depends on, such as its database or its broker, that the
// test can take down and bring back while the role runs
export interface TcpProxy {
	readonly port: number;
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
	return {
		port: address.port,
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
