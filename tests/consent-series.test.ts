import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runTool } from '../src/agent/tools.js';
import { ORGANIZATION_PRINCIPAL } from '../src/principals/principal.js';
import {
	modelFor,
	QUESTION_CONTENT_KEY,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';
import { grantConsent, withdrawConsent } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import {
	brokerRefusal,
	CALENDAR_CATALOG,
	INVITATION_ANSWERS_CATALOG,
	INVITATION_CANCELLED,
	RECURRING_INVITATION,
	UNPREVIEWED_INVITATION_ANSWERS_CATALOG,
	type ContractCall,
	type ContractReply
} from './helpers/fake-apisix.js';

// What the gateway relays from the platform's broker once Alice's permission for her assistant to
// act for her expired
const PERMISSION_EXPIRED = brokerRefusal('delegation_expired');

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Every question of the harness to answer yes or no, whatever it asks, as Alice's client tells it
// from its content
function askedIn(r: ConsentRoom): DecryptedMessage[] {
	return r.client.messages.filter(
		(m) =>
			m.roomId === r.room &&
			m.sender === r.assistantId &&
			m.content[QUESTION_CONTENT_KEY] !== undefined
	);
}

// Alice's invitations, by the UID of their events: her weekly standup, which repeats every Monday;
// the quarterly offsite, which repeated too until Paul cancelled it; and one Monday's review, which
// Paul invited her to without the rest of its series
const STANDUP = 'standup-weekly@calendar.test';
const OFFSITE = 'offsite-quarterly@calendar.test';
const REVIEW = 'review-one-monday@calendar.test';

// What Alice's calendar says answering the standup for the whole series would do
const ACCEPT_SUMMARY =
	'Accept the whole series "Standup", every Monday from 2026-10-12 at 09:00, organized by Paul\nCalendar tells the organizer';
const DECLINE_SUMMARY =
	'Decline the whole series "Standup", every Monday from 2026-10-12 at 09:00, organized by Paul\nCalendar tells the organizer';
const FRENCH_ACCEPT_SUMMARY =
	"Accepter toute la série « Standup », chaque lundi dès le 12/10/2026 à 09:00, organisée par Paul\nAgenda le dit à l'organisateur";
// The digest of what that answer acts on
const DIGEST = 'sha256:standup-1';
// The answer for the whole series as the harness shows the call, where no summary stands in its
// place
const WHOLE_SERIES_CALL = JSON.stringify({ body: { uid: STANDUP, series: true } }, null, 2);

// The header by which a contract says it only previewed a call
const PREVIEWED = { 'x-twake-preview': 'true' } as const;

// How the harness asks Alice whether to answer for the whole series, naming her calendar as the
// catalog does, and how every request ends, in each language
const SERIES = 'This is a series in calendar: shall I answer for the whole series?';
const ANSWER = 'Answer yes or no in your next message.';
// How it asks her to give that permission again, the deployment having no consent link to show
const EXPIRED =
	'To change your data in calendar, I need your permission to act on your behalf, and the one you gave me has expired.';
const FRENCH_SERIES = "C'est une série dans calendar : je réponds pour toute la série ?";
const FRENCH_ANSWER = 'Réponds par oui ou non dans ton prochain message.';

// A text that is not the harness's, as Alice's client shows it in plain text: quoted line by line
// under the harness's label
function quoted(label: string, text: string): string {
	return [label, ...text.split('\n').map((line) => `> ${line}`)].join('\n');
}

// What Alice asks, and what the model calls for it
const REQUESTS = {
	'Accept the standup': { tool: 'accept_invitation', args: { body: { uid: STANDUP } } },
	'Decline the standup': { tool: 'decline_invitation', args: { body: { uid: STANDUP } } },
	'Accept the offsite': { tool: 'accept_invitation', args: { body: { uid: OFFSITE } } },
	'Accept the review': { tool: 'accept_invitation', args: { body: { uid: REVIEW } } },
	// The model answers for the whole series of its own accord, whether the invitation repeats or not
	'Accept the standup, every Monday': {
		tool: 'accept_invitation',
		args: { body: { uid: STANDUP, series: true } }
	},
	'Accept the offsite, every quarter': {
		tool: 'accept_invitation',
		args: { body: { uid: OFFSITE, series: true } }
	},
	'Accept the review and the rest of its series': {
		tool: 'accept_invitation',
		args: { body: { uid: REVIEW, series: true } }
	},
	'Parle-moi en français': { tool: 'set_language', args: { language: 'fr' } },
	'Accepte le standup': { tool: 'accept_invitation', args: { body: { uid: STANDUP } } }
};

// The calls that waited for Alice's answer about a series, summed over the api replicas' metrics
// as an operator's dashboard reads them
async function seriesRequests(r: ConsentRoom): Promise<number> {
	const sample =
		/^harness_consent_requests_total\{domain="calendar",level="write",reason="series"\} (\d+)$/m;
	let sum = 0;
	for (const app of r.h.apps) {
		const text = (await app.inject({ method: 'GET', url: '/metrics' })).body;
		sum += Number(sample.exec(text)?.[1] ?? 0);
	}
	return sum;
}

function questionsIn(r: ConsentRoom, question: string = SERIES): DecryptedMessage[] {
	return r.saying(question);
}

async function nextQuestionIn(
	r: ConsentRoom,
	seen: number,
	question: string = SERIES
): Promise<DecryptedMessage> {
	for (let i = 0; i < 120; i += 1) {
		const latest = questionsIn(r, question).at(seen);
		if (latest !== undefined) return latest;
		await sleep(250);
	}
	throw new Error('no new question from the harness');
}

describe('my assistant asks me whether to answer for a whole series before it answers a recurring invitation', () => {
	let r: ConsentRoom;
	// What Alice's calendar wrote: her answers, as their invitations now have them
	const written: { uid: unknown; partstat: string }[] = [];

	// Alice's calendar behind the gateway, as the contract answers: an invitation whose event was
	// cancelled is refused before anything else; a recurring one, unless the call answers for the
	// whole series; and the review, which her copy holds alone, is answered as an event either way.
	// Asked what an answer would do, it tells of the answer for the standup's whole series, the only
	// one previewed here; it writes an answer otherwise.
	function calendar(c: ContractCall): ContractReply {
		const body = c.body as { readonly uid?: unknown; readonly series?: unknown };
		if (body.uid === OFFSITE) return INVITATION_CANCELLED;
		if (body.uid === STANDUP && body.series !== true) return RECURRING_INVITATION;
		const accepting = c.path.endsWith('/accept');
		if (c.headers['x-twake-preview'] !== undefined) {
			const summary = !accepting
				? DECLINE_SUMMARY
				: c.headers['accept-language'] === 'fr'
					? FRENCH_ACCEPT_SUMMARY
					: ACCEPT_SUMMARY;
			return { status: 200, headers: PREVIEWED, body: { summary, digest: DIGEST } };
		}
		const answer = { uid: body.uid, partstat: accepting ? 'ACCEPTED' : 'DECLINED' };
		written.push(answer);
		return { status: 200, body: answer };
	}

	// What the gateway passed on to the calendar, call by call: whether it was a preview, and the body
	function calendarCalls(): [string | null, unknown][] {
		return r.h.apisix.contracts.calls.map((c) => [c.headers['x-twake-preview'] ?? null, c.body]);
	}

	beforeAll(async () => {
		r = await startConsentRoom({ ADMISSION_USER_PER_MINUTE: '100' });
		r.h.apisix.contracts.spec = INVITATION_ANSWERS_CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(2);
		r.h.apisix.contracts.handler = calendar;
		r.h.apisix.llm.script = modelFor(REQUESTS);
		// Alice lets her assistant write in her calendar: answering an invitation is a low-risk write
		// it makes without asking her each time
		await grantConsent(r.h.db, 'alice@test.local', 'calendar', 'write');
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});
	beforeEach(() => {
		r.h.apisix.contracts.calls.length = 0;
		written.length = 0;
	});

	it('asks me when I accept a recurring invitation, showing what the calendar would do, and writes nothing until I answer', async () => {
		const seen = questionsIn(r).length;
		const modelCalls = r.h.apisix.llm.calls.length;
		await r.client.sendText(r.room, 'Accept the standup');
		const question = await nextQuestionIn(r, seen);
		expect(question.body).toBe(
			[SERIES, quoted('calendar describes it as:', ACCEPT_SUMMARY), ANSWER].join('\n\n')
		);
		await r.requestAskedIn(question.eventId, 'calendar');
		await sleep(1000);
		// The calendar refused the answer for one occurrence, then said what the answer for the whole
		// series would do, and the model was never asked what to make of it
		expect(calendarCalls()).toEqual([
			[null, { uid: STANDUP }],
			['true', { uid: STANDUP, series: true }]
		]);
		expect(written).toEqual([]);
		expect(r.h.apisix.llm.calls).toHaveLength(modelCalls + 1);
		// The wait is logged with why, never with what the call would send
		const waits = r.h.logLines().filter((l) => l['msg'] === 'contract call waits for its owner');
		expect(waits.at(-1)).toMatchObject({
			tool: 'accept_invitation',
			domain: 'calendar',
			consentLevel: 'write',
			reasons: ['series'],
			preview: true,
			principal: 'alice@test.local'
		});
		expect(r.h.logLines().some((l) => JSON.stringify(l).includes(STANDUP))).toBe(false);
		expect(await seriesRequests(r)).toBe(1);
	});

	it('answers for the whole series once I say yes, and the calendar writes it once', async () => {
		const seen = questionsIn(r).length;
		await r.client.sendText(r.room, 'Accept the standup');
		await nextQuestionIn(r, seen);
		const found = r.saying('Found:').length;
		const modelCalls = r.h.apisix.llm.calls.length;
		await r.client.sendText(r.room, 'yes');
		expect(await r.nextSaying('Found:', found)).toContain('"partstat":"ACCEPTED"');
		await sleep(1000);
		// The answer for the whole series went once, with the digest of what I was shown
		expect(calendarCalls()).toEqual([
			[null, { uid: STANDUP }],
			['true', { uid: STANDUP, series: true }],
			[null, { uid: STANDUP, series: true }]
		]);
		expect(r.h.apisix.contracts.calls.at(-1)?.headers['x-twake-preview-digest']).toBe(DIGEST);
		expect(written).toEqual([{ uid: STANDUP, partstat: 'ACCEPTED' }]);
		// The model goes on knowing that its call waited for my answer about the series, then went
		// for the whole series
		expect(r.h.apisix.llm.calls).toHaveLength(modelCalls + 1);
		const history = r.h.apisix.llm.calls[modelCalls]?.request.messages ?? [];
		const waited = history
			.filter((m) => m.role === 'tool' && m.tool_call_id === 'call_accept_invitation')
			.at(-1);
		expect(JSON.parse(waited?.content ?? '{}')).toEqual({
			status: 'awaiting_owner',
			reasons: ['series'],
			domain: 'calendar',
			level: 'write'
		});
		// It read my question as I did, with the call for the whole series in place of what the
		// calendar said of it, which only I read
		expect(
			history.some(
				(m) =>
					m.role === 'assistant' && m.content === [SERIES, WHOLE_SERIES_CALL, ANSWER].join('\n\n')
			)
		).toBe(true);
		expect(JSON.stringify(history)).not.toContain('Calendar tells the organizer');
		const replayed = history.filter((m) => m.role === 'assistant' && m.tool_calls !== undefined);
		expect(
			replayed.at(-1)?.tool_calls?.map((c) => [c.function.name, JSON.parse(c.function.arguments)])
		).toEqual([['accept_invitation', { body: { uid: STANDUP, series: true } }]]);
	});

	it('declines the whole series once I say yes, and the calendar writes it once', async () => {
		const seen = questionsIn(r).length;
		await r.client.sendText(r.room, 'Decline the standup');
		const question = await nextQuestionIn(r, seen);
		expect(question.body).toBe(
			[SERIES, quoted('calendar describes it as:', DECLINE_SUMMARY), ANSWER].join('\n\n')
		);
		await r.requestAskedIn(question.eventId, 'calendar');
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'yes');
		expect(await r.nextSaying('Found:', found)).toContain('"partstat":"DECLINED"');
		await sleep(1000);
		expect(calendarCalls()).toEqual([
			[null, { uid: STANDUP }],
			['true', { uid: STANDUP, series: true }],
			[null, { uid: STANDUP, series: true }]
		]);
		expect(r.h.apisix.contracts.calls.at(-1)?.headers['x-twake-preview-digest']).toBe(DIGEST);
		expect(written).toEqual([{ uid: STANDUP, partstat: 'DECLINED' }]);
	});

	it('asks me when I decline a recurring invitation, and writes nothing when I say no', async () => {
		const seen = questionsIn(r).length;
		await r.client.sendText(r.room, 'Decline the standup');
		const question = await nextQuestionIn(r, seen);
		expect(question.body).toBe(
			[SERIES, quoted('calendar describes it as:', DECLINE_SUMMARY), ANSWER].join('\n\n')
		);
		await r.requestAskedIn(question.eventId, 'calendar');
		const acknowledged = r.saying('All right').length;
		const modelCalls = r.h.apisix.llm.calls.length;
		await r.client.sendText(r.room, 'no');
		expect(await r.nextSaying('All right', acknowledged)).toBe('All right, I will not do it.');
		await sleep(1000);
		expect(calendarCalls()).toEqual([
			[null, { uid: STANDUP }],
			['true', { uid: STANDUP, series: true }]
		]);
		expect(written).toEqual([]);
		expect(r.h.apisix.llm.calls).toHaveLength(modelCalls);
	});

	it('tries the answer for one occurrence first when the assistant answers for the whole series of its own accord, and asks me about the series once the calendar refuses it', async () => {
		const seen = questionsIn(r).length;
		await r.client.sendText(r.room, 'Accept the standup, every Monday');
		const question = await nextQuestionIn(r, seen);
		expect(question.body).toBe(
			[SERIES, quoted('calendar describes it as:', ACCEPT_SUMMARY), ANSWER].join('\n\n')
		);
		await r.requestAskedIn(question.eventId, 'calendar');
		await sleep(1000);
		// The calendar got the answer without the series the assistant set, refused it, then said
		// what the answer for the whole series would do
		expect(calendarCalls()).toEqual([
			[null, { uid: STANDUP }],
			['true', { uid: STANDUP, series: true }]
		]);
		expect(written).toEqual([]);
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'yes');
		expect(await r.nextSaying('Found:', found)).toContain('"partstat":"ACCEPTED"');
		await sleep(1000);
		expect(questionsIn(r)).toHaveLength(seen + 1);
		expect(calendarCalls()).toEqual([
			[null, { uid: STANDUP }],
			['true', { uid: STANDUP, series: true }],
			[null, { uid: STANDUP, series: true }]
		]);
		expect(r.h.apisix.contracts.calls.at(-1)?.headers['x-twake-preview-digest']).toBe(DIGEST);
		expect(written).toEqual([{ uid: STANDUP, partstat: 'ACCEPTED' }]);
	});

	it('asks me about the series, then for my consent as a first write does, before it writes in my calendar for the first time', async () => {
		await withdrawConsent(r.h.db, 'alice@test.local', 'calendar', 'write');
		try {
			const seen = questionsIn(r).length;
			await r.client.sendText(r.room, 'Accept the standup');
			const series = await nextQuestionIn(r, seen);
			expect(series.body).toBe(
				[SERIES, quoted('calendar describes it as:', ACCEPT_SUMMARY), ANSWER].join('\n\n')
			);
			await r.requestAskedIn(series.eventId, 'calendar');
			// My yes to the whole series goes the usual way of a first write: it asks for my consent,
			// showing what the calendar says the answer for the whole series does
			const consents = r.questions().length;
			await r.client.sendText(r.room, 'yes');
			const consent = await r.nextQuestion(consents);
			expect(r.client.messages.find((m) => m.eventId === consent)?.body).toBe(
				[
					'This is the first time I need to change your data in calendar. Do you allow it? I would start with this:',
					quoted('calendar describes it as:', ACCEPT_SUMMARY),
					ANSWER
				].join('\n\n')
			);
			await r.requestAskedIn(consent, 'calendar');
			expect(written).toEqual([]);
			// My yes there writes it, once
			const found = r.saying('Found:').length;
			await r.client.sendText(r.room, 'yes');
			expect(await r.nextSaying('Found:', found)).toContain('"partstat":"ACCEPTED"');
			await sleep(1000);
			expect(calendarCalls()).toEqual([
				['true', { uid: STANDUP }],
				['true', { uid: STANDUP, series: true }],
				['true', { uid: STANDUP, series: true }],
				[null, { uid: STANDUP, series: true }]
			]);
			expect(written).toEqual([{ uid: STANDUP, partstat: 'ACCEPTED' }]);
		} finally {
			await grantConsent(r.h.db, 'alice@test.local', 'calendar', 'write');
		}
	});

	it('asks me about the whole series the assistant answered for of its own accord only once the calendar refused one occurrence, then for my consent, once each, before it first writes in my calendar', async () => {
		await withdrawConsent(r.h.db, 'alice@test.local', 'calendar', 'write');
		try {
			const seen = questionsIn(r).length;
			await r.client.sendText(r.room, 'Accept the standup, every Monday');
			const series = await nextQuestionIn(r, seen);
			expect(series.body).toBe(
				[SERIES, quoted('calendar describes it as:', ACCEPT_SUMMARY), ANSWER].join('\n\n')
			);
			const consents = r.questions().length;
			await r.client.sendText(r.room, 'yes');
			const consent = await r.nextQuestion(consents);
			expect(r.client.messages.find((m) => m.eventId === consent)?.body).toBe(
				[
					'This is the first time I need to change your data in calendar. Do you allow it? I would start with this:',
					quoted('calendar describes it as:', ACCEPT_SUMMARY),
					ANSWER
				].join('\n\n')
			);
			const found = r.saying('Found:').length;
			await r.client.sendText(r.room, 'yes');
			expect(await r.nextSaying('Found:', found)).toContain('"partstat":"ACCEPTED"');
			await sleep(1000);
			// Neither question came back once answered, and the calendar was first asked what the
			// answer without the series the assistant set would do
			expect(questionsIn(r)).toHaveLength(seen + 1);
			expect(r.questions()).toHaveLength(consents + 1);
			expect(calendarCalls()).toEqual([
				['true', { uid: STANDUP }],
				['true', { uid: STANDUP, series: true }],
				['true', { uid: STANDUP, series: true }],
				[null, { uid: STANDUP, series: true }]
			]);
			expect(written).toEqual([{ uid: STANDUP, partstat: 'ACCEPTED' }]);
		} finally {
			await grantConsent(r.h.db, 'alice@test.local', 'calendar', 'write');
		}
	});

	it('asks me about the whole series once when the platform refuses the answer I said yes to, and writes it once I give my permission again', async () => {
		// The platform's broker refuses the answer for the whole series once: Alice's permission for
		// her assistant to act for her expired after the calendar said what the answer would do
		let refused = false;
		r.h.apisix.contracts.handler = (c) => {
			const previewed = c.headers['x-twake-preview'] !== undefined;
			if (!refused && !previewed && (c.body as { readonly series?: unknown }).series === true) {
				refused = true;
				return PERMISSION_EXPIRED;
			}
			return calendar(c);
		};
		try {
			const asked = askedIn(r).length;
			const seen = questionsIn(r).length;
			await r.client.sendText(r.room, 'Accept the standup');
			await nextQuestionIn(r, seen);
			const expired = r.saying(EXPIRED).length;
			await r.client.sendText(r.room, 'yes');
			expect(await r.nextSaying(EXPIRED, expired)).toBe(`${EXPIRED}\nShall I try again? ${ANSWER}`);
			expect(written).toEqual([]);
			const found = r.saying('Found:').length;
			await r.client.sendText(r.room, 'yes');
			expect(await r.nextSaying('Found:', found)).toContain('"partstat":"ACCEPTED"');
			await sleep(1000);
			// My yes to the series held through the broker's refusal: the answer for the whole series
			// went again as I allowed it, with the digest of what I was shown, and the series and that
			// permission were each asked about once
			expect(askedIn(r)).toHaveLength(asked + 2);
			expect(questionsIn(r)).toHaveLength(seen + 1);
			expect(calendarCalls()).toEqual([
				[null, { uid: STANDUP }],
				['true', { uid: STANDUP, series: true }],
				[null, { uid: STANDUP, series: true }],
				[null, { uid: STANDUP, series: true }]
			]);
			expect(r.h.apisix.contracts.calls.at(-1)?.headers['x-twake-preview-digest']).toBe(DIGEST);
			expect(written).toEqual([{ uid: STANDUP, partstat: 'ACCEPTED' }]);
		} finally {
			r.h.apisix.contracts.handler = calendar;
		}
	});

	it('asks me about the whole series after my yes to the platform, when the platform refused the calendar telling what the answer for the whole of it would do', async () => {
		// The platform's broker refuses the calendar's preview of the answer for the whole series
		// once: Alice's permission for her assistant to act for her expired after the calendar
		// refused the answer for one occurrence
		let refused = false;
		r.h.apisix.contracts.handler = (c) => {
			if (!refused && c.headers['x-twake-preview'] !== undefined) {
				refused = true;
				return PERMISSION_EXPIRED;
			}
			return calendar(c);
		};
		try {
			const seen = questionsIn(r).length;
			const expired = r.saying(EXPIRED).length;
			await r.client.sendText(r.room, 'Accept the standup');
			await r.nextSaying(EXPIRED, expired);
			expect(questionsIn(r)).toHaveLength(seen);
			// My yes to that permission says nothing about the series: I am asked about it next
			await r.client.sendText(r.room, 'yes');
			const question = await nextQuestionIn(r, seen);
			expect(question.body).toBe(
				[SERIES, quoted('calendar describes it as:', ACCEPT_SUMMARY), ANSWER].join('\n\n')
			);
			expect(written).toEqual([]);
			const found = r.saying('Found:').length;
			await r.client.sendText(r.room, 'yes');
			expect(await r.nextSaying('Found:', found)).toContain('"partstat":"ACCEPTED"');
			await sleep(1000);
			// The call waited for that permission without the series, which reached the calendar's
			// writing only once I said yes to it
			expect(calendarCalls()).toEqual([
				[null, { uid: STANDUP }],
				['true', { uid: STANDUP, series: true }],
				[null, { uid: STANDUP }],
				['true', { uid: STANDUP, series: true }],
				[null, { uid: STANDUP, series: true }]
			]);
			expect(written).toEqual([{ uid: STANDUP, partstat: 'ACCEPTED' }]);
		} finally {
			r.h.apisix.contracts.handler = calendar;
		}
	});

	it('asks nothing about a series when the calendar refuses even the answer for the whole of it, and the model reads why', async () => {
		r.h.apisix.contracts.handler = () => RECURRING_INVITATION;
		try {
			const seen = questionsIn(r).length;
			const heard = r.saying('Heard:').length;
			await r.client.sendText(r.room, 'Accept the standup');
			expect(await r.nextSaying('Heard:', heard)).toContain('"error":"preview_refused"');
			await sleep(1000);
			expect(questionsIn(r)).toHaveLength(seen);
			expect(calendarCalls()).toEqual([
				[null, { uid: STANDUP }],
				['true', { uid: STANDUP, series: true }]
			]);
			expect(written).toEqual([]);
		} finally {
			r.h.apisix.contracts.handler = calendar;
		}
	});

	it('asks nothing about a series when the calendar cannot be told to answer for the whole of it, and the model reads why', async () => {
		// The calendar's contracts before they answered for whole series: the body of an answer names
		// the invitation alone, and a recurring one is refused all the same
		r.h.apisix.contracts.spec = CALENDAR_CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBeGreaterThan(0);
		try {
			const seen = questionsIn(r).length;
			const heard = r.saying('Heard:').length;
			await r.client.sendText(r.room, 'Accept the standup');
			expect(await r.nextSaying('Heard:', heard)).toContain('"code":"recurring_invitation"');
			await sleep(1000);
			expect(questionsIn(r)).toHaveLength(seen);
			expect(calendarCalls()).toEqual([[null, { uid: STANDUP }]]);
			expect(written).toEqual([]);
		} finally {
			r.h.apisix.contracts.spec = INVITATION_ANSWERS_CATALOG;
			for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(2);
		}
	});

	it('shows me the answer for the whole series itself when the calendar cannot say what it would do', async () => {
		r.h.apisix.contracts.spec = UNPREVIEWED_INVITATION_ANSWERS_CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(2);
		try {
			const seen = questionsIn(r).length;
			await r.client.sendText(r.room, 'Accept the standup');
			const question = await nextQuestionIn(r, seen);
			expect(question.body).toBe([SERIES, WHOLE_SERIES_CALL, ANSWER].join('\n\n'));
			await r.requestAskedIn(question.eventId, 'calendar');
			expect(written).toEqual([]);
			const found = r.saying('Found:').length;
			await r.client.sendText(r.room, 'yes');
			expect(await r.nextSaying('Found:', found)).toContain('"partstat":"ACCEPTED"');
			expect(calendarCalls()).toEqual([
				[null, { uid: STANDUP }],
				[null, { uid: STANDUP, series: true }]
			]);
			expect(written).toEqual([{ uid: STANDUP, partstat: 'ACCEPTED' }]);
		} finally {
			r.h.apisix.contracts.spec = INVITATION_ANSWERS_CATALOG;
			for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(2);
		}
	});

	it('asks nothing about a series when the organizer cancelled the invitation, and the model reads why', async () => {
		const asked = askedIn(r).length;
		const waited = await seriesRequests(r);
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Accept the offsite');
		expect(await r.nextSaying('Heard:', heard)).toContain('"code":"invitation_cancelled"');
		await sleep(1000);
		expect(askedIn(r)).toHaveLength(asked);
		expect(await seriesRequests(r)).toBe(waited);
		expect(calendarCalls()).toEqual([[null, { uid: OFFSITE }]]);
		expect(written).toEqual([]);
	});

	it('answers an occurrence I was invited to without the rest of its series as an event, asking nothing', async () => {
		const asked = askedIn(r).length;
		const waited = await seriesRequests(r);
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'Accept the review');
		expect(await r.nextSaying('Found:', found)).toContain('"partstat":"ACCEPTED"');
		await sleep(1000);
		expect(askedIn(r)).toHaveLength(asked);
		expect(await seriesRequests(r)).toBe(waited);
		expect(calendarCalls()).toEqual([[null, { uid: REVIEW }]]);
		expect(written).toEqual([{ uid: REVIEW, partstat: 'ACCEPTED' }]);
	});

	it('answers an invitation that does not repeat as an event when the assistant answers for its series of its own accord, asking nothing', async () => {
		const asked = askedIn(r).length;
		const waited = await seriesRequests(r);
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'Accept the review and the rest of its series');
		expect(await r.nextSaying('Found:', found)).toContain('"partstat":"ACCEPTED"');
		await sleep(1000);
		expect(askedIn(r)).toHaveLength(asked);
		expect(await seriesRequests(r)).toBe(waited);
		// The calendar got the answer without the series the assistant set
		expect(calendarCalls()).toEqual([[null, { uid: REVIEW }]]);
		expect(written).toEqual([{ uid: REVIEW, partstat: 'ACCEPTED' }]);
	});

	it('asks nothing about a series when the assistant answers for the whole of a cancelled one of its own accord, and the model reads why', async () => {
		// A calendar that cannot say what an answer would do: nothing is asked of it before the call
		r.h.apisix.contracts.spec = UNPREVIEWED_INVITATION_ANSWERS_CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(2);
		try {
			const asked = askedIn(r).length;
			const waited = await seriesRequests(r);
			const heard = r.saying('Heard:').length;
			await r.client.sendText(r.room, 'Accept the offsite, every quarter');
			expect(await r.nextSaying('Heard:', heard)).toContain('"code":"invitation_cancelled"');
			await sleep(1000);
			expect(askedIn(r)).toHaveLength(asked);
			expect(await seriesRequests(r)).toBe(waited);
			expect(calendarCalls()).toEqual([[null, { uid: OFFSITE }]]);
			expect(written).toEqual([]);
		} finally {
			r.h.apisix.contracts.spec = INVITATION_ANSWERS_CATALOG;
			for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(2);
		}
	});

	it('keeps the whole series I said yes to when the platform refuses the calendar telling what my first write there would do, and writes it once I give my permission and my consent', async () => {
		await withdrawConsent(r.h.db, 'alice@test.local', 'calendar', 'write');
		// The platform's broker refuses the calendar's second preview of the answer for the whole
		// series: Alice's permission for her assistant to act for her expired after her yes to the
		// series, as the calendar was asked what her first write there would do
		let seriesPreviews = 0;
		r.h.apisix.contracts.handler = (c) => {
			const previewed = c.headers['x-twake-preview'] !== undefined;
			if (previewed && (c.body as { readonly series?: unknown }).series === true) {
				seriesPreviews += 1;
				if (seriesPreviews === 2) return PERMISSION_EXPIRED;
			}
			return calendar(c);
		};
		try {
			const seen = questionsIn(r).length;
			await r.client.sendText(r.room, 'Accept the standup');
			await nextQuestionIn(r, seen);
			const expired = r.saying(EXPIRED).length;
			await r.client.sendText(r.room, 'yes');
			await r.nextSaying(EXPIRED, expired);
			const consents = r.questions().length;
			await r.client.sendText(r.room, 'yes');
			await r.nextQuestion(consents);
			const found = r.saying('Found:').length;
			await r.client.sendText(r.room, 'yes');
			expect(await r.nextSaying('Found:', found)).toContain('"partstat":"ACCEPTED"');
			await sleep(1000);
			// The call waited for that permission with the series I said yes to, which I was not asked
			// about again, and the calendar wrote the answer for the whole series once
			expect(questionsIn(r)).toHaveLength(seen + 1);
			expect(calendarCalls()).toEqual([
				['true', { uid: STANDUP }],
				['true', { uid: STANDUP, series: true }],
				['true', { uid: STANDUP, series: true }],
				['true', { uid: STANDUP, series: true }],
				[null, { uid: STANDUP, series: true }]
			]);
			expect(written).toEqual([{ uid: STANDUP, partstat: 'ACCEPTED' }]);
		} finally {
			r.h.apisix.contracts.handler = calendar;
			await grantConsent(r.h.db, 'alice@test.local', 'calendar', 'write');
		}
	});

	it('takes the series out of a call I make through the API myself: an invitation that does not repeat is answered as an event, and a recurring one waits for my answer about the series', async () => {
		const app = r.h.apps[0];
		if (app === undefined) throw new Error('no replica');
		const authorization = `Bearer ${await r.h.issuer.mint({ sub: 'alice@test.local' })}`;
		const review = await app.inject({
			method: 'POST',
			url: '/v1/tool',
			headers: { authorization },
			payload: { tool: 'accept_invitation', arguments: { body: { uid: REVIEW, series: true } } }
		});
		expect(review.statusCode).toBe(200);
		expect(calendarCalls()).toEqual([[null, { uid: REVIEW }]]);
		r.h.apisix.contracts.calls.length = 0;
		const standup = await app.inject({
			method: 'POST',
			url: '/v1/tool',
			headers: { authorization },
			payload: { tool: 'accept_invitation', arguments: { body: { uid: STANDUP, series: true } } }
		});
		expect(standup.statusCode).toBe(202);
		expect(standup.json<{ pending_call: { reasons: string[] } }>().pending_call.reasons).toEqual([
			'series'
		]);
		// The calendar got the answer without the series I set, refused it, then said what the answer
		// for the whole series would do
		expect(calendarCalls()).toEqual([
			[null, { uid: STANDUP }],
			['true', { uid: STANDUP, series: true }]
		]);
		expect(written).toEqual([{ uid: REVIEW, partstat: 'ACCEPTED' }]);
	});

	it('leaves the organization agent, which has nobody to ask, the series it sets, and the refusal of a recurring invitation as data', async () => {
		const app = r.h.apps[0];
		if (app === undefined) throw new Error('no replica');
		const tool = app.agent.contracts.tools.find(
			(t) => t.definition.function.name === 'accept_invitation'
		);
		if (tool === undefined) throw new Error('no tool');
		const context = {
			principalId: ORGANIZATION_PRINCIPAL,
			actions: ['contracts.call', 'contracts.act'],
			db: r.h.db,
			log: app.log
		};
		const whole = await runTool(tool, { body: { uid: STANDUP, series: true } }, context);
		expect(whole.pendingCallId).toBeUndefined();
		expect(whole.result).toMatchObject({ status: 200, body: { partstat: 'ACCEPTED' } });
		const one = await runTool(tool, { body: { uid: STANDUP } }, context);
		expect(one.pendingCallId).toBeUndefined();
		expect(one.final).toBeUndefined();
		expect(one.result).toMatchObject({ status: 409, body: { code: 'recurring_invitation' } });
		expect(calendarCalls()).toEqual([
			[null, { uid: STANDUP, series: true }],
			[null, { uid: STANDUP }]
		]);
	});

	// Last: Alice speaks French with her assistant from then on
	it('asks me in my own language', async () => {
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Parle-moi en français');
		expect(await r.nextSaying('Heard:', heard)).toContain('"language":"fr"');
		r.h.apisix.contracts.calls.length = 0;
		const seen = questionsIn(r, FRENCH_SERIES).length;
		await r.client.sendText(r.room, 'Accepte le standup');
		const question = await nextQuestionIn(r, seen, FRENCH_SERIES);
		expect(question.body).toBe(
			[
				FRENCH_SERIES,
				quoted('Description donnée par calendar :', FRENCH_ACCEPT_SUMMARY),
				FRENCH_ANSWER
			].join('\n\n')
		);
		await r.requestAskedIn(question.eventId, 'calendar');
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'oui');
		expect(await r.nextSaying('Found:', found)).toContain('"partstat":"ACCEPTED"');
		expect(written).toEqual([{ uid: STANDUP, partstat: 'ACCEPTED' }]);
	});
});
