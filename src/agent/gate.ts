export interface TurnGate {
	run<T>(key: string, task: () => Promise<T>): Promise<T>;
}

// Turns of one principal run one after the other; different principals run in parallel.
export function makeTurnGate(): TurnGate {
	const tails = new Map<string, Promise<unknown>>();
	return {
		async run<T>(key: string, task: () => Promise<T>): Promise<T> {
			const previous = tails.get(key) ?? Promise.resolve();
			const current = previous.then(task, task);
			const tail = current.catch(() => undefined);
			tails.set(key, tail);
			try {
				return await current;
			} finally {
				if (tails.get(key) === tail) tails.delete(key);
			}
		}
	};
}
