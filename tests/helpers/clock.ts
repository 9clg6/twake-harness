import type { Clock } from '../../src/agent/clock.js';

export interface SettableClock extends Clock {
	set(iso: string): void;
}

// A clock the test moves by hand, so the moment the harness reads is known in advance
export function makeSettableClock(iso: string): SettableClock {
	let current = new Date(iso);
	return {
		now: () => new Date(current.getTime()),
		set: (next) => {
			current = new Date(next);
		}
	};
}
