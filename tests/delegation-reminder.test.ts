import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig, type Config } from '../src/config.js';
import { startWorkerRole, type WorkerRole } from '../src/worker/role.js';
import { silent, until } from './helpers/activity.js';
import { makeSettableClock } from './helpers/clock.js';
import { startConsentRoom, type ConsentRoom } from './helpers/consent-room.js';
import {
	BROKER_CONSENT_URL,
	brokerDelegation,
	brokerNoDelegation,
	type ContractReply
} from './helpers/fake-apisix.js';

const ALICE = 'alice@test.local';
const BOB = 'bob@test.local';
// The deployment's consent link bound to Alice, as the harness binds every consent link it shows
// her
const ALICE_CONSENT_URL = `${BROKER_CONSENT_URL}?owner=alice%40test.local`;
// The consent link the broker's answers carry, which no reminder shows
const ANSWERED_CONSENT_URL = 'https://agent-consent.test.local/elsewhere';
// How a reminder starts, in French, the language of the suite
const REMINDER = "L'autorisation d'agir en ton nom";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('the hour of the reminders', () => {
	const base = {
		HARNESS_ROLE: 'worker',
		DATABASE_URL: 'postgres://x@localhost/x',
		AUTH_JWKS_URL: 'https://example.test/jwks',
		AUTH_ISSUER: 'https://example.test/',
		AUTH_AUDIENCE: 'twake-harness',
		APISIX_BASE_URL: 'http://apisix.test',
		APISIX_CONSUMER_KEY: 'k'
	};

	it('is nine unless set', () => {
		expect(loadConfig(base).consent.delegationReminderHour).toBe(9);
		expect(
			loadConfig({ ...base, DELEGATION_REMINDER_HOUR: '0' }).consent.delegationReminderHour
		).toBe(0);
	});

	it('refuses, at startup, an hour that is not one of the day', () => {
		for (const hour of ['24', '-1', '9.5', 'nine']) {
			expect(() => loadConfig({ ...base, DELEGATION_REMINDER_HOUR: hour })).toThrow(
				'invalid configuration: DELEGATION_REMINDER_HOUR'
			);
		}
	});
});

describe('my assistant reminds me to renew my permission for it to act for me before it expires', () => {
	let r: ConsentRoom;
	let worker: WorkerRole | null = null;
	const clock = makeSettableClock('2026-10-08T07:00:00Z');

	// The worker role on the harness's database, reading the suite's clock, and looking often
	// whether the hour of the reminders has come
	async function startWorker(consent: Partial<Config['consent']> = {}): Promise<void> {
		worker = await startWorkerRole({
			config: { ...r.h.config, role: 'worker', consent: { ...r.h.config.consent, ...consent } },
			db: r.h.db,
			logStream: silent(),
			clock,
			reminderCheckMs: 50
		});
	}

	async function stopWorker(): Promise<void> {
		await worker?.stop();
		worker = null;
	}

	// How many times the broker's route was asked about an owner so far
	const asked = (owner: string): number =>
		r.h.apisix.delegationCalls.filter((call) => call.owner === owner).length;

	beforeAll(async () => {
		r = await startConsentRoom({
			ASSISTANT_LOCALE: 'fr',
			ASSISTANT_TIMEZONE: 'Europe/Paris',
			BROKER_CONSENT_URL
		});
	}, 240_000);
	afterEach(stopWorker);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('tells me at nine, five days before it expires, when it expires and where to renew it, and asks me nothing', async () => {
		r.h.apisix.delegation = (owner) =>
			owner === ALICE
				? brokerDelegation('2026-09-13T14:23:51Z', '2026-10-13T14:23:51Z', ANSWERED_CONSENT_URL)
				: null;
		// Nine in Paris, on Thursday 8 October
		clock.set('2026-10-08T07:00:00Z');
		await startWorker();
		// The link is the deployment's, never the one the broker's answer carries
		expect(await r.nextSaying(REMINDER, 0)).toBe(
			`L'autorisation d'agir en ton nom que tu m'as donnée expire le mardi 13 octobre 2026 à 16:23. Renouvelle-la d'ici là pour que je continue à agir pour toi : ${ALICE_CONSENT_URL}`
		);
		// The gateway is asked the way a contract call is: with the harness's key, for its owner
		const call = r.h.apisix.delegationCalls.at(-1);
		expect(call?.headers['apikey']).toBe(r.h.apisix.consumerKey);
		expect(call?.owner).toBe(ALICE);
		// It carries no marker of a question, and the harness takes no answer from my next words:
		// they go to my assistant
		expect(r.saying(REMINDER)[0]?.content).not.toHaveProperty(['app.twake.assistant.question']);
		await r.client.sendText(r.room, 'oui');
		expect(await r.nextSaying('echo: ', 0)).toBe('echo: oui');
	});

	it('reminds me of nothing when the deployment gives no consent link to show me', async () => {
		r.h.apisix.delegation = (owner) =>
			owner === ALICE ? brokerDelegation('2026-09-14T08:00:00Z', '2026-10-14T08:00:00Z') : null;
		const before = asked(ALICE);
		// Nine in Paris on Friday 9 October, five days before it expires
		clock.set('2026-10-09T07:00:00Z');
		await startWorker({ brokerConsentUrl: null });
		await sleep(500);
		expect(asked(ALICE)).toBe(before);
	});

	it('reminds me once of the permission I gave, however often the pass runs, and once of the one I give next', async () => {
		const seen = r.saying(REMINDER).length;
		let held = brokerDelegation('2026-10-20T10:00:00Z', '2026-11-19T10:00:00Z');
		r.h.apisix.delegation = (owner) => (owner === ALICE ? held : null);
		// Nine in Paris on Monday 16 November, three days before it expires
		clock.set('2026-11-16T08:00:00Z');
		await startWorker();
		expect(await r.nextSaying(REMINDER, seen)).toContain(
			'expire le jeudi 19 novembre 2026 à 11:00.'
		);
		// The pass runs again the next day, then once more after a restart of the role
		let before = asked(ALICE);
		clock.set('2026-11-17T08:00:00Z');
		await until('the pass of the next day asked the broker', () => asked(ALICE) > before);
		await stopWorker();
		before = asked(ALICE);
		await startWorker();
		await until('the pass after a restart asked the broker', () => asked(ALICE) > before);
		await stopWorker();
		// I renewed it that day: the new one is reminded of in its turn, three days before it expires
		held = brokerDelegation('2026-11-17T09:00:00Z', '2026-12-17T09:00:00Z');
		clock.set('2026-12-14T08:00:00Z');
		await startWorker();
		// A room's messages go out in order: a second reminder of the first one would come before
		expect(await r.nextSaying(REMINDER, seen + 1)).toContain(
			'expire le jeudi 17 décembre 2026 à 10:00.'
		);
	});

	it('runs at the hour the deployment sets, on the wall clock of its time zone', async () => {
		const seen = r.saying(REMINDER).length;
		r.h.apisix.delegation = (owner) =>
			owner === ALICE ? brokerDelegation('2026-12-20T12:00:00Z', '2027-01-15T12:00:00Z') : null;
		const before = asked(ALICE);
		// 17:59 in Paris on Monday 11 January, a minute before the hour set
		clock.set('2027-01-11T16:59:00Z');
		await startWorker({ delegationReminderHour: 18 });
		await sleep(500);
		expect(asked(ALICE)).toBe(before);
		// 18:00 in Paris, 17:00 in UTC
		clock.set('2027-01-11T17:00:00Z');
		expect(await r.nextSaying(REMINDER, seen)).toContain(
			'expire le vendredi 15 janvier 2027 à 13:00.'
		);
	});

	it('reminds me of nothing while the broker holds no permission of mine, or an expired one, or cannot be asked, and goes on with the next owner', async () => {
		await r.h.synapse.registerUser('bob');
		const created = await r.h.api.post(BOB, '/v1/assistants', { name: 'Friday' });
		expect(created.status).toBe(201);
		const seen = r.saying(REMINDER).length;
		// What the broker answers about Alice, one pass a day; about Bob, a permission it holds
		let answer: ContractReply | null = null;
		r.h.apisix.delegation = (owner) =>
			owner === BOB ? brokerDelegation('2027-01-05T10:00:00Z', '2027-02-04T10:00:00Z') : answer;
		const answers: (ContractReply | null)[] = [
			// None, or none any more
			brokerNoDelegation(),
			// One that expired the day before
			brokerDelegation('2027-01-02T08:00:00Z', '2027-02-01T08:00:00Z'),
			// A gateway without the route, a broker that fails, a connection that drops
			{ status: 404, body: { error_msg: '404 Route Not Found' } },
			{ status: 502, body: { error_msg: 'upstream unavailable' } },
			null
		];
		for (const [index, reply] of answers.entries()) {
			answer = reply;
			const before = asked(BOB);
			// Nine in Paris, from Monday 1 February on
			clock.set(`2027-02-0${index + 1}T08:00:00Z`);
			if (worker === null) await startWorker();
			await until('the pass went on with Bob', () => asked(BOB) > before);
		}
		// Once the broker holds a permission of mine about to expire, its reminder is the first
		answer = brokerDelegation('2027-01-08T10:00:00Z', '2027-02-07T10:00:00Z');
		clock.set('2027-02-06T08:00:00Z');
		expect(await r.nextSaying(REMINDER, seen)).toContain(
			'expire le dimanche 7 février 2027 à 11:00.'
		);
	});
});
