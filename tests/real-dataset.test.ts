import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { mayArrangeMeeting } from '../src/suggestions/prefilter.js';
import { MEETING_THRESHOLD, meetingRequest, readMeeting } from '../src/suggestions/sort.js';

const upstream = process.env['LLM_UPSTREAM_URL'];
const key = process.env['LLM_DECISION_UPSTREAM_KEY'];
const model = process.env['LLM_DECISION_MODEL'];
// A set of labelled exchanges kept outside the repository: real ones, which are never versioned
const dataset = process.env['ROUTING_DATASET'];
// The part of it measured: the one thresholds are set on, unless the held-out one is asked for,
// once, when they are frozen
const split = process.env['DATASET_SPLIT'] ?? 'dev';

const AT_ONCE = 6;

interface Exchange {
	readonly id: string;
	readonly split: string;
	readonly lines: readonly string[];
	readonly proposes: readonly string[];
}

const share = (part: number, whole: number): number =>
	whole === 0 ? 1 : Math.round((part / whole) * 1000) / 1000;

async function probability(lines: readonly string[]): Promise<number> {
	const quoted = lines.map((line) => ({
		author: line.slice(0, 1),
		email: '',
		text: line.slice(3)
	}));
	const res = await fetch(upstream ?? '', {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
		body: JSON.stringify({ model, messages: meetingRequest(quoted) })
	});
	const body = (await res.json()) as { choices?: { message: { content: string | null } }[] };
	return readMeeting(body.choices?.[0]?.message.content ?? null) ?? -1;
}

// The two nets of the suggestions against real exchanges: the words the harness looks for, and
// the decision model. An exchange counts when it arranges a meeting or asks when someone is free.
describe.skipIf(
	upstream === undefined || key === undefined || model === undefined || dataset === undefined
)('the nets of the suggestions against real exchanges', () => {
	it('tells the exchanges that arrange a meeting', { timeout: 900_000 }, async () => {
		const exchanges = readFileSync(dataset ?? '', 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Exchange)
			.filter((exchange) => exchange.split === split);
		const given: number[] = [];
		for (let i = 0; i < exchanges.length; i += AT_ONCE) {
			const batch = exchanges.slice(i, i + AT_ONCE);
			given.push(...(await Promise.all(batch.map((exchange) => probability(exchange.lines)))));
		}
		const wanted = exchanges.map((exchange) =>
			exchange.proposes.some((name) => name === 'create_event' || name === 'read_freebusy')
		);
		const score = (named: (index: number) => boolean): Record<string, number> => {
			let hit = 0;
			let extra = 0;
			let missed = 0;
			for (const index of exchanges.keys()) {
				if (named(index) && wanted[index]) hit += 1;
				if (named(index) && !wanted[index]) extra += 1;
				if (!named(index) && wanted[index]) missed += 1;
			}
			return {
				hit,
				extra,
				missed,
				precision: share(hit, hit + extra),
				recall: share(hit, hit + missed)
			};
		};
		const report = {
			split,
			exchanges: exchanges.length,
			toFind: wanted.filter(Boolean).length,
			words: score((index) => mayArrangeMeeting(exchanges[index]?.lines.at(-1)?.slice(3) ?? '')),
			decisionModel: Object.fromEntries(
				[0.5, MEETING_THRESHOLD, 0.7, 0.8, 0.9].map((threshold) => [
					threshold,
					score((index) => (given[index] ?? -1) >= threshold)
				])
			),
			// Which ones the decision model gets wrong at its threshold, by their mark alone: the
			// exchanges themselves stay out of the output
			wrong: exchanges
				.map((exchange, index) => ({
					id: exchange.id,
					wanted: wanted[index],
					probability: Number((given[index] ?? -1).toFixed(2))
				}))
				.filter((one) => one.probability >= MEETING_THRESHOLD !== one.wanted)
		};
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		expect(report.exchanges).toBeGreaterThan(0);
	});
});
