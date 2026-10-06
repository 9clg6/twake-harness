import type { ErrorLog } from './listeners.js';

// Enough frames to find the failing call; the rest of the stack adds nothing to the log
const STACK_FRAMES = 5;

export interface RejectionGuard {
	// The rejections survived since the guard was installed
	readonly count: number;
	uninstall(): void;
}

// What the log keeps of a rejection: what failed and where it was thrown. Never the rejected value
// itself, nor what an error carries beside its message, a response body for instance, which may
// hold what a user wrote.
export function describeRejection(reason: unknown): Record<string, unknown> {
	if (!(reason instanceof Error)) return { type: typeof reason };
	const frames = (reason.stack ?? '')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith('at '))
		.slice(0, STACK_FRAMES);
	return { name: reason.name, message: reason.message, frames };
}

// The last resort of the matrix role, and of it only. The SDK processes each push of Synapse
// inside a promise that nothing awaits, so an error thrown there, as "Encryption not possible:
// server not revealing device ID" was, is an unhandled rejection, which Node turns into the end of
// the process. In an application service that holds the assistants of every owner, one failing
// push must not take them all down: the rejection is logged, counted for the alerts, and the role
// carries on with the next push. An uncaught exception keeps Node's default and ends the process:
// thrown synchronously, it may leave the process half-way through a change, whereas a rejection
// only ends the work of its own promise.
export function installRejectionGuard(log: ErrorLog): RejectionGuard {
	let count = 0;
	const listener = (reason: unknown): void => {
		count += 1;
		log.error(
			{ rejection: describeRejection(reason), total: count },
			'unhandled rejection survived'
		);
	};
	process.on('unhandledRejection', listener);
	return {
		get count(): number {
			return count;
		},
		uninstall(): void {
			process.off('unhandledRejection', listener);
		}
	};
}
