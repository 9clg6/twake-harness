import { describe, expect, it } from 'vitest';

import { READ_THRESHOLD, readProbabilities, WRITE_THRESHOLD } from '../src/agent/route.js';
import { CONVERSATION_CASES } from './fixtures/conversation-cases.js';
import { ROUTING_CAPABILITIES } from './fixtures/routing-cases.js';

const upstream = process.env['LLM_UPSTREAM_URL'];
const key = process.env['LLM_DECISION_UPSTREAM_KEY'];
const model = process.env['LLM_DECISION_MODEL'];

const AT_ONCE = 6;

// What each proposal is, said for an exchange between two people: when it applies, and when not
const PROPOSALS: Readonly<Record<string, string>> = {
	read_freebusy:
		'check in the calendar whether A is free, because B asks A when or whether A is available and A has not answered with a time',
	list_events: 'list the invitations A received, because A or B wonders which invitations A has',
	search_emails:
		'search the mail of A, because a mail is mentioned that A has not found or needs to read',
	create_event:
		'put a meeting in the calendar of A, because A and B have just agreed to meet or talk at a precise day and time and no calendar invitation exists yet',
	accept_invitation:
		'accept a calendar invitation, because B says they sent A an invitation and A says they will come',
	send_email:
		'send a mail for A, because A has just said they will send something by mail, or agreed to when B asked, and has not done it yet'
};

// What the decision model is asked of an exchange the assistant is not spoken to in: for each
// thing it can do, whether to propose it to its owner. The harness does not read such exchanges
// yet; this measures whether the decision model could tell them apart.
function proposalRequest(lines: readonly string[]): unknown {
	return {
		state: `A conversation between the owner of an assistant (A) and another person (B). The assistant is not spoken to; it reads along.\n${lines.join('\n')}`,
		questions: Object.fromEntries(
			ROUTING_CAPABILITIES.map((capability) => [
				capability.name,
				{
					type: 'noul',
					instructions: `Should the assistant now propose to A to ${PROPOSALS[capability.name] ?? capability.description}? Answer no when it is vague, already done, cancelled, in the past or about someone else.`
				}
			])
		)
	};
}

async function sort(lines: readonly string[]): Promise<ReadonlyMap<string, number>> {
	const res = await fetch(upstream ?? '', {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
		body: JSON.stringify({
			model,
			messages: [{ role: 'user', content: JSON.stringify(proposalRequest(lines)) }]
		})
	});
	const body = (await res.json()) as { choices?: { message: { content: string | null } }[] };
	const given = readProbabilities(body.choices?.[0]?.message.content ?? null);
	if (given === null) throw new Error(`no decision for "${lines.join(' / ')}": HTTP ${res.status}`);
	return given;
}

const share = (part: number, whole: number): number =>
	whole === 0 ? 1 : Math.round((part / whole) * 1000) / 1000;

describe.skipIf(upstream === undefined || key === undefined || model === undefined)(
	'the decision model that tells what to propose from an exchange between two people',
	() => {
		it('names what a set of known exchanges calls for', { timeout: 600_000 }, async () => {
			const sorted: ReadonlyMap<string, number>[] = [];
			for (let i = 0; i < CONVERSATION_CASES.length; i += AT_ONCE) {
				const batch = CONVERSATION_CASES.slice(i, i + AT_ONCE);
				sorted.push(...(await Promise.all(batch.map(([lines]) => sort(lines)))));
			}
			const count = { hit: 0, miss: 0, extra: 0 };
			// An exchange is right when exactly what it calls for is named
			let exchanges = 0;
			const mistakes: string[] = [];
			for (const [index, [lines, proposes]] of CONVERSATION_CASES.entries()) {
				const given = sorted[index] ?? new Map<string, number>();
				let right = true;
				for (const capability of ROUTING_CAPABILITIES) {
					const probability = given.get(capability.name) ?? 0;
					const named = probability >= (capability.acts ? WRITE_THRESHOLD : READ_THRESHOLD);
					const wanted = proposes.includes(capability.name);
					if (named && wanted) count.hit += 1;
					if (!named && wanted) count.miss += 1;
					if (named && !wanted) count.extra += 1;
					if (named !== wanted) {
						right = false;
						mistakes.push(
							`${named ? 'extra' : 'missed'} ${capability.name} ${probability.toFixed(2)} | ${lines.join(' / ')}`
						);
					}
				}
				if (right) exchanges += 1;
			}
			const report = {
				exchanges: CONVERSATION_CASES.length,
				right: exchanges,
				accuracy: share(exchanges, CONVERSATION_CASES.length),
				proposals: {
					...count,
					precision: share(count.hit, count.hit + count.extra),
					recall: share(count.hit, count.hit + count.miss)
				},
				mistakes
			};
			process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
			// A first measure, not yet a bar the harness depends on
			expect(report.exchanges).toBe(CONVERSATION_CASES.length);
		});
	}
);
