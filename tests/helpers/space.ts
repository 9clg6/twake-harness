import { createServer, type Server } from 'node:http';

export interface SpaceCall {
	readonly path: string;
	readonly authorization: string | null;
	readonly body: Record<string, unknown>;
}

// Twake Space's notifications as the harness calls them: it records what it is sent
export interface FakeSpace {
	readonly url: string;
	readonly calls: SpaceCall[];
	// What it answers, 201 with an id unless set
	reply: { status: number; body: unknown };
	close(): Promise<void>;
}

export async function startFakeSpace(): Promise<FakeSpace> {
	const calls: SpaceCall[] = [];
	const space: FakeSpace = {
		url: '',
		calls,
		reply: { status: 201, body: { id: 'n-1' } },
		close: () => new Promise((resolve) => server.close(() => resolve()))
	};
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			calls.push({
				path: req.url ?? '',
				authorization: req.headers.authorization ?? null,
				body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
			});
			res.statusCode = space.reply.status;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(space.reply.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('no port');
	return Object.assign(space, { url: `http://127.0.0.1:${address.port}/api` });
}
