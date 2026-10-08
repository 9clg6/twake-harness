import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { modelFor, startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { grantConsent, withdrawConsent } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import {
	CALENDAR_CATALOG,
	INVITATION_ANSWERS_CATALOG,
	INVITATION_CANCELLED,
	RECURRING_INVITATION,
	UNPREVIEWED_INVITATION_ANSWERS_CATALOG,
	type ContractCall,
	type ContractReply
} from './helpers/fake-apisix.js';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
// And answering the review, an event that does not repeat
const REVIEW_SUMMARY =
	'Accept "Review", Monday 2026-10-12 at 14:00, organized by Paul\nCalendar tells the organizer';
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
	// The model answers for the whole series of its own accord
	'Accept the standup, every Monday': {
		tool: 'accept_invitation',
		args: { body: { uid: STANDUP, series: true } }
	},
	'Decline the standup': { tool: 'decline_invitation', args: { body: { uid: STANDUP } } },
	'Accept the offsite': { tool: 'accept_invitation', args: { body: { uid: OFFSITE } } },
	'Accept the review': { tool: 'accept_invitation', args: { body: { uid: REVIEW } } },
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
	// Asked, it says what an answer would do, and writes it otherwise.
	function calendar(c: ContractCall): ContractReply {
		const body = c.body as { readonly uid?: unknown; readonly series?: unknown };
		if (body.uid === OFFSITE) return INVITATION_CANCELLED;
		if (body.uid === STANDUP && body.series !== true) return RECURRING_INVITATION;
		const accepting = c.path.endsWith('/accept');
		if (c.headers['x-twake-preview'] !== undefined) {
			const summary =
				body.uid === REVIEW
					? REVIEW_SUMMARY
					: !accepting
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
			level: 'write',
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

	it('asks me about the whole series when the assistant answers for it of its own accord, and writes it once I say yes', async () => {
		const seen = questionsIn(r).length;
		await r.client.sendText(r.room, 'Accept the standup, every Monday');
		const question = await nextQuestionIn(r, seen);
		expect(question.body).toBe(
			[SERIES, quoted('calendar describes it as:', ACCEPT_SUMMARY), ANSWER].join('\n\n')
		);
		await r.requestAskedIn(question.eventId, 'calendar');
		await sleep(1000);
		// The calendar only said what the answer would do
		expect(calendarCalls()).toEqual([['true', { uid: STANDUP, series: true }]]);
		expect(written).toEqual([]);
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'yes');
		expect(await r.nextSaying('Found:', found)).toContain('"partstat":"ACCEPTED"');
		await sleep(1000);
		expect(calendarCalls()).toEqual([
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

	it('asks me about the whole series the assistant answers for of its own accord, then for my consent, once each, before it first writes in my calendar', async () => {
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
			// Neither question came back once answered
			expect(r.questions()).toHaveLength(consents + 1);
			expect(calendarCalls()).toEqual([
				['true', { uid: STANDUP, series: true }],
				['true', { uid: STANDUP, series: true }],
				[null, { uid: STANDUP, series: true }]
			]);
			expect(written).toEqual([{ uid: STANDUP, partstat: 'ACCEPTED' }]);
		} finally {
			await grantConsent(r.h.db, 'alice@test.local', 'calendar', 'write');
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
		const questions = r.questions().length;
		const heard = r.saying('Heard:').length;
		await r.client.sendText(r.room, 'Accept the offsite');
		expect(await r.nextSaying('Heard:', heard)).toContain('"code":"invitation_cancelled"');
		await sleep(1000);
		expect(r.questions()).toHaveLength(questions);
		expect(calendarCalls()).toEqual([[null, { uid: OFFSITE }]]);
		expect(written).toEqual([]);
	});

	it('answers an occurrence I was invited to without the rest of its series as an event, asking nothing', async () => {
		const questions = r.questions().length;
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'Accept the review');
		expect(await r.nextSaying('Found:', found)).toContain('"partstat":"ACCEPTED"');
		await sleep(1000);
		expect(r.questions()).toHaveLength(questions);
		expect(calendarCalls()).toEqual([[null, { uid: REVIEW }]]);
		expect(written).toEqual([{ uid: REVIEW, partstat: 'ACCEPTED' }]);
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
