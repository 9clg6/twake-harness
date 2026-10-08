import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

// The harness as a deployment starts it
const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));

// A role of the harness in a process of its own, which a test may kill as a node fails
export interface WorkerProcess {
	// Its log lines so far, one JSON object each
	lines(): Record<string, unknown>[];
	text(): string;
	// Sends it a signal, and resolves once it is gone
	kill(signal: NodeJS.Signals): Promise<void>;
}

// A port free now, for a process to listen on
export async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (address === null || typeof address === 'string') throw new Error('no port');
	return address.port;
}

export function spawnWorker(env: Readonly<Record<string, string>>): Promise<WorkerProcess> {
	const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
		env: { ...process.env, ...env },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const chunks: string[] = [];
	child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
	child.stderr.resume();
	const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
	const text = (): string => chunks.join('');
	return Promise.resolve({
		text,
		// The lines it ended, the last one being written yet when it has no end
		lines: () =>
			text()
				.split('\n')
				.slice(0, -1)
				.filter((line) => line.startsWith('{'))
				.map((line) => JSON.parse(line) as Record<string, unknown>),
		kill: async (signal) => {
			if (child.exitCode === null && child.signalCode === null) child.kill(signal);
			await exited;
		}
	});
}
