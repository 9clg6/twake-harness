import type { Answer, AnswerKind } from './answers.js';
import type { CallSubject } from './repository.js';

// What came of an owner's answer: it decided the call, or it came once the request had expired or
// a newer one had superseded it, and ran nothing
export type AnswerOutcome = 'decided' | 'expired' | 'superseded';

// A replayed call succeeded when its contract answered with a 2xx status; any other answer, or
// none, failed it
export type ReplayOutcome = 'ok' | 'failed';

export function replayOutcome(httpStatus: number | null): ReplayOutcome {
	return httpStatus !== null && httpStatus >= 200 && httpStatus < 300 ? 'ok' : 'failed';
}

// What a role counts of consent as it happens there, by application, level and reason: never the
// owner, the room or what a call would send, so that the labels hold no personal data and take a
// handful of values each. Every process counts its own, as each replica's /metrics does.
export interface ConsentMetrics {
	// A call frozen until its owner answers
	requested(call: CallSubject): void;
	answered(call: CallSubject, answer: Answer, via: AnswerKind, outcome: AnswerOutcome): void;
	// A request closed unanswered: its lifetime ran out, or a newer one in its room replaced it
	expired(call: CallSubject): void;
	superseded(call: CallSubject): void;
	// The call its owner allowed ran
	replayed(call: CallSubject, outcome: ReplayOutcome): void;
	// The counters in the Prometheus text format, a line each; a counter shows once it counted
	exposition(): string[];
}

type Labels = Readonly<Record<string, string>>;

function escapeLabel(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// A call that waits for several reasons counts once, under all of them, so that a counter's
// total stays the number of calls
function labelsOf(call: CallSubject): Labels {
	return { domain: call.domain, level: call.level, reason: [...call.reasons].sort().join('+') };
}

interface Counter {
	add(labels: Labels): void;
	lines(): string[];
}

function makeCounter(name: string): Counter {
	const counts = new Map<string, number>();
	return {
		add: (labels) => {
			const key = Object.entries(labels)
				.map(([label, value]) => `${label}="${escapeLabel(value)}"`)
				.join(',');
			counts.set(key, (counts.get(key) ?? 0) + 1);
		},
		lines: () =>
			counts.size === 0
				? []
				: [`# TYPE ${name} counter`, ...[...counts].map(([key, n]) => `${name}{${key}} ${n}`)]
	};
}

export function makeConsentMetrics(): ConsentMetrics {
	const requests = makeCounter('harness_consent_requests_total');
	const answers = makeCounter('harness_consent_answers_total');
	const expiries = makeCounter('harness_consent_expiries_total');
	const supersessions = makeCounter('harness_consent_supersessions_total');
	const replays = makeCounter('harness_consent_replays_total');
	return {
		requested: (call) => {
			requests.add(labelsOf(call));
		},
		answered: (call, answer, via, outcome) => {
			answers.add({ ...labelsOf(call), answer, via, outcome });
		},
		expired: (call) => {
			expiries.add(labelsOf(call));
		},
		superseded: (call) => {
			supersessions.add(labelsOf(call));
		},
		replayed: (call, outcome) => {
			replays.add({ ...labelsOf(call), outcome });
		},
		exposition: () =>
			[requests, answers, expiries, supersessions, replays].flatMap((counter) => counter.lines())
	};
}
