import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runBriefPass } from '../src/briefs/schedule.js';
import { lastUser, until } from './helpers/activity.js';
import { makeSettableClock } from './helpers/clock.js';
import { startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import { grantConsent } from './helpers/consents.js';
import type { DecryptedMessage } from './helpers/e2ee-client.js';
import { CALENDAR_CATALOG, type ChatRequest, type ContractCall } from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
// Where the content of a brief tells Alice's client that it is one, and of which day
const BRIEF_CONTENT_KEY = 'app.twake.assistant.brief';
// Monday 12 October 2026 at eight in Paris
const MONDAY_AT_EIGHT = '2026-10-12T06:00:00Z';
const LIST_EVENTS = '/contracts/v1/calendar/events';
// What the model writes as the brief
const WRITTEN = 'Ce matin : le stand-up à 9 h, que chevauche la revue de design.';

// What her calendar's contract lists for a day: a stand-up and a design review that overlap, as the
// contract computes it, and lunch after them
function dayOf(date: string): Record<string, unknown> {
	const at = (time: string): string => `${date}T${time}:00+02:00`;
	return {
		time_zone: 'Europe/Paris',
		start: at('00:00'),
		end: `${date}T23:59:59+02:00`,
		events: [
			{
				uid: 'standup',
				recurrence_id: at('09:00'),
				start: at('09:00'),
				end: at('09:30'),
				all_day: false,
				status: 'CONFIRMED',
				private: false,
				my_partstat: 'ACCEPTED',
				needs_action: false,
				conflicts: [{ uid: 'review', recurrence_id: null }],
				untrusted: {
					title: 'Stand-up',
					location: null,
					description: null,
					organizer: 'bob@test.local'
				}
			},
			{
				uid: 'review',
				recurrence_id: null,
				start: at('09:15'),
				end: at('10:00'),
				all_day: false,
				status: 'CONFIRMED',
				private: false,
				my_partstat: 'NEEDS-ACTION',
				needs_action: true,
				conflicts: [{ uid: 'standup', recurrence_id: at('09:00') }],
				untrusted: {
					title: 'Revue de design',
					location: 'Salle 4',
					description: 'Apporter les maquettes',
					organizer: 'carol@test.local'
				}
			},
			{
				uid: 'lunch',
				recurrence_id: null,
				start: at('12:30'),
				end: at('13:30'),
				all_day: false,
				status: null,
				private: true,
				my_partstat: null,
				needs_action: false,
				conflicts: [],
				untrusted: { title: 'Déjeuner', location: null, description: null, organizer: null }
			}
		],
		truncated: false
	};
}

// What the model is handed: one line of JSON between the fences of a nonce
const FENCED = /<<<calendar-data ([0-9a-f]{12})\n(.+)\ncalendar-data \1>>>/;

function dataOf(told: string): unknown {
	const line = FENCED.exec(told)?.[2];
	if (line === undefined) throw new Error(`no calendar data in ${told}`);
	return JSON.parse(line) as unknown;
}

describe('every working day at eight, the brief of my meetings arrives in my room', () => {
	let r: ConsentRoom;
	const clock = makeSettableClock(MONDAY_AT_EIGHT);

	// The briefs Alice's client received from her assistant, oldest first
	const briefs = (): DecryptedMessage[] =>
		r.client.messages.filter(
			(m) =>
				m.roomId === r.room &&
				m.sender === r.assistantId &&
				m.content[BRIEF_CONTENT_KEY] !== undefined
		);

	async function nextBrief(seen: number): Promise<DecryptedMessage> {
		await until('a new brief', () => briefs().length > seen);
		const brief = briefs()[seen];
		if (brief === undefined) throw new Error('no brief');
		return brief;
	}

	// The model calls of the briefs, by what they tell the model
	const briefCalls = (): ChatRequest[] =>
		r.h.apisix.llm.calls
			.map((call) => call.request)
			.filter((request) => lastUser(request).startsWith('[brief]'));

	// The reads of her calendar's days that reached the gateway
	const dayReads = (): ContractCall[] =>
		r.h.apisix.contracts.calls.filter((call) => call.path === LIST_EVENTS);

	// The worker role's pass, as it runs every minute, at the time the clock says
	async function pass(at: string): Promise<void> {
		clock.set(at);
		const app = r.h.apps[0];
		if (app === undefined) throw new Error('no api role');
		await runBriefPass({ config: r.h.config, db: r.h.db, log: app.log, clock });
	}

	// The events Synapse notified Alice of, as her phone would be by a push
	async function notified(): Promise<string[]> {
		const response = await r.h.synapse.request(
			r.alice,
			'GET',
			'/_matrix/client/v3/notifications?limit=100'
		);
		const notifications = response.body['notifications'] as
			{ readonly event?: { readonly event_id?: string } }[] | undefined;
		return (notifications ?? []).map((n) => n.event?.event_id ?? '');
	}

	beforeAll(async () => {
		r = await startConsentRoom(
			{ ASSISTANT_LOCALE: 'fr', ASSISTANT_TIMEZONE: 'Europe/Paris', BRIEF_ENABLED: 'true' },
			{ clock }
		);
		r.h.apisix.contracts.spec = CALENDAR_CATALOG;
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBeGreaterThan(0);
	}, 240_000);

	beforeEach(async () => {
		await grantConsent(r.h.db, ALICE, 'calendar', 'read');
		r.h.apisix.contracts.handler = (call) =>
			call.path === LIST_EVENTS
				? { status: 200, body: dayOf(String(call.query['from'])) }
				: { status: 404, body: {} };
		r.h.apisix.llm.script = (request) =>
			lastUser(request).startsWith('[brief]')
				? { content: WRITTEN }
				: { content: `echo: ${lastUser(request)}` };
	});

	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('on a Monday at eight in my zone, I get one message marked as the brief, written by the model from the day’s read of my calendar, which notifies me and stays in our conversation', async () => {
		const seen = briefs().length;
		const calls = briefCalls().length;
		const reads = dayReads().length;
		await pass(MONDAY_AT_EIGHT);
		const brief = await nextBrief(seen);
		expect(brief.body).toBe(WRITTEN);
		expect(brief.content['msgtype']).toBe('m.text');
		expect(brief.content[BRIEF_CONTENT_KEY]).toEqual({ date: '2026-10-12' });
		// The day's read, for Alice, under the brief's own correlation id
		const read = dayReads().slice(reads);
		expect(read).toHaveLength(1);
		expect(read[0]?.method).toBe('GET');
		expect(read[0]?.query).toEqual({ from: '2026-10-12', days: '1', limit: '20' });
		expect(read[0]?.headers['x-twake-on-behalf-of']).toBe(ALICE);
		expect(read[0]?.headers['x-correlation-id']).toMatch(/^brief-2026-10-12-[0-9a-f]{16}$/);
		// One model call, with no tools and no history: what the model is told, then the day's
		// meetings as data, their conflicts included, and what people wrote under untrusted
		const asked = briefCalls().slice(calls);
		expect(asked).toHaveLength(1);
		const request = asked[0];
		expect(request?.tools).toBeUndefined();
		expect(request?.messages.map((m) => m.role)).toEqual(['system', 'user']);
		const told = lastUser(request);
		expect(told).toContain('(id brief-2026-10-12-');
		expect(dataOf(told)).toEqual({
			date: '2026-10-12',
			calendar: {
				time_zone: 'Europe/Paris',
				meetings: (dayOf('2026-10-12')['events'] as unknown[]).slice(),
				truncated: false
			}
		});
		// It notifies her, as any message of her assistant does
		await until('the brief notified', async () => (await notified()).includes(brief.eventId));
		// And her next turn reads it in the conversation
		const turns = r.h.apisix.llm.calls.length;
		await r.client.sendText(r.room, 'Et après le déjeuner ?');
		await r.nextSaying('echo: Et après le déjeuner ?', 0);
		const next = r.h.apisix.llm.calls.slice(turns).at(0)?.request;
		expect(next?.messages.some((m) => m.role === 'assistant' && m.content === WRITTEN)).toBe(true);
	});
});
