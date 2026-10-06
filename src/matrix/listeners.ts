// All a guard needs of a logger: the role's own one fits, and so does a test's
export interface ErrorLog {
	error(fields: Record<string, unknown>, msg: string): void;
}

export type GuardedListener<A extends readonly unknown[]> = (...args: A) => void;

// The work a stop has to wait for: the listeners under way, and what they start in the background
export interface WorkTracker {
	// The work must handle its own failure, as a guarded listener does: its rejection is not caught here
	track(work: Promise<unknown>): void;
	readonly size: number;
}

export function makeWorkTracker(): WorkTracker {
	const pending = new Set<Promise<unknown>>();
	return {
		track(work: Promise<unknown>): void {
			const task: Promise<unknown> = work.finally(() => {
				pending.delete(task);
			});
			pending.add(task);
		},
		get size(): number {
			return pending.size;
		}
	};
}

export type ListenerGuard = <A extends readonly unknown[]>(
	name: string,
	handler: (...args: A) => Promise<void>,
	context: (...args: A) => Record<string, unknown>
) => GuardedListener<A>;

// The SDK emits its events without awaiting the listeners, so a listener that rejects leaves an
// unhandled rejection, and Node ends the process: every assistant stops with the one that failed.
// Each listener is wrapped instead. Its failure is logged at error with the identifiers of what it
// was handling, never its content, and the role carries on with the next event. With a tracker,
// the listener also counts as work under way until it settles, so that a stop can wait for it.
export function makeListenerGuard(log: ErrorLog, tracker?: WorkTracker): ListenerGuard {
	return <A extends readonly unknown[]>(
			name: string,
			handler: (...args: A) => Promise<void>,
			context: (...args: A) => Record<string, unknown>
		): GuardedListener<A> =>
		(...args: A): void => {
			const work = handler(...args).catch((err: unknown) => {
				log.error({ ...context(...args), err }, `${name} failed`);
			});
			tracker?.track(work);
		};
}
