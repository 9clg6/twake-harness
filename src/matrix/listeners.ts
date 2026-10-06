// All a guard needs of a logger: the role's own one fits, and so does a test's
export interface ErrorLog {
	error(fields: Record<string, unknown>, msg: string): void;
}

export type GuardedListener<A extends readonly unknown[]> = (...args: A) => void;

export type ListenerGuard = <A extends readonly unknown[]>(
	name: string,
	handler: (...args: A) => Promise<void>,
	context: (...args: A) => Record<string, unknown>
) => GuardedListener<A>;

// The SDK emits its events without awaiting the listeners, so a listener that rejects leaves an
// unhandled rejection, and Node ends the process: every assistant stops with the one that failed.
// Each listener is wrapped instead. Its failure is logged at error with the identifiers of what it
// was handling, never its content, and the role carries on with the next event.
export function makeListenerGuard(log: ErrorLog): ListenerGuard {
	return <A extends readonly unknown[]>(
			name: string,
			handler: (...args: A) => Promise<void>,
			context: (...args: A) => Record<string, unknown>
		): GuardedListener<A> =>
		(...args: A): void => {
			handler(...args).catch((err: unknown) => {
				log.error({ ...context(...args), err }, `${name} failed`);
			});
		};
}
