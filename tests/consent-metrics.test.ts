import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startWorkerRole } from '../src/worker/role.js';
import {
	modelFor,
	modelUsing,
	readCatalog,
	startConsentRoom,
	type ConsentRoom
} from './helpers/consent-room.js';

const DOMAINS = ['mail', 'drive', 'tasks', 'notes', 'photos', 'wiki', 'contacts'];

const REQUESTS = 'harness_consent_requests_total';
const ANSWERS = 'harness_consent_answers_total';
const EXPIRIES = 'harness_consent_expiries_total';
const SUPERSESSIONS = 'harness_consent_supersessions_total';
const REPLAYS = 'harness_consent_replays_total';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The labels of a first read in an application, which waits for its owner's consent
function firstRead(domain: string): Record<string, string> {
	return { domain, level: 'read', reason: 'consent' };
}

interface Sample {
	readonly name: string;
	readonly labels: Readonly<Record<string, string>>;
	readonly value: number;
}

// The samples of a Prometheus exposition, as a scraper reads them
function samplesOf(text: string): Sample[] {
	return text.split('\n').flatMap((line) => {
		const sample = /^(\w+)(?:\{(.*)\})? (\S+)$/.exec(line);
		if (sample === null) return [];
		const pairs = [...(sample[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)];
		return [
			{
				name: sample[1] ?? '',
				labels: Object.fromEntries(pairs.map((pair) => [pair[1] ?? '', pair[2] ?? ''])),
				value: Number(sample[3])
			}
		];
	});
}

// What an operator's sum(name{selector}) reads over the instances of a role
function total(texts: readonly string[], name: string, selector: Record<string, string>): number {
	return texts
		.flatMap(samplesOf)
		.filter(
			(s) =>
				s.name === name && Object.entries(selector).every(([key, value]) => s.labels[key] === value)
		)
		.reduce((sum, s) => sum + s.value, 0);
}

// A counter moves once its role is done, which may be just after the owner sees the effect: the
// scraper reads it again until it shows the value expected, as a dashboard refreshes
async function scraped(
	scrape: () => Promise<string[]>,
	name: string,
	selector: Record<string, string>,
	expected: number
): Promise<number> {
	let value = total(await scrape(), name, selector);
	for (let i = 0; i < 40 && value !== expected; i += 1) {
		await sleep(250);
		value = total(await scrape(), name, selector);
	}
	return value;
}

// Each replica of the api role, as the scraper reads every pod of a deployment
async function apiMetrics(r: ConsentRoom): Promise<string[]> {
	return Promise.all(
		r.h.apps.map(async (app) => (await app.inject({ method: 'GET', url: '/metrics' })).body)
	);
}

async function matrixMetrics(r: ConsentRoom): Promise<string[]> {
	return [await (await fetch(`http://127.0.0.1:${r.h.port}/metrics`)).text()];
}

describe('an operator sees how consent behaves', () => {
	let r: ConsentRoom;
	const api = (): Promise<string[]> => apiMetrics(r);
	const matrix = (): Promise<string[]> => matrixMetrics(r);
	beforeAll(async () => {
		r = await startConsentRoom({ ADMISSION_USER_PER_MINUTE: '100' });
		r.h.apisix.contracts.spec = readCatalog(DOMAINS);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(DOMAINS.length);
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});
	beforeEach(() => {
		r.h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
	});

	it('counts the request on the api role, my yes on the matrix role, then the replay', async () => {
		r.h.apisix.llm.script = modelUsing('search_mail', { q: 'budget' });
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Find the budget in my mail');
		const question = await r.nextQuestion(seen);
		expect(await scraped(api, REQUESTS, firstRead('mail'), 1)).toBe(1);
		const found = r.saying('Found:').length;
		await r.client.react(r.room, question, '✅ YES');
		await r.nextSaying('Found:', found);
		const yes = { ...firstRead('mail'), answer: 'yes', via: 'reaction', outcome: 'decided' };
		expect(await scraped(matrix, ANSWERS, yes, 1)).toBe(1);
		expect(await scraped(api, REPLAYS, { ...firstRead('mail'), outcome: 'ok' }, 1)).toBe(1);
		// Each role counts what it does itself
		expect(total(await matrix(), REQUESTS, {})).toBe(0);
		expect(total(await matrix(), REPLAYS, {})).toBe(0);
		expect(total(await api(), ANSWERS, {})).toBe(0);
	});

	it('counts my answers by what they say and how they came', async () => {
		r.h.apisix.llm.script = modelFor({
			'Find my plan in my drive': { tool: 'search_drive', args: { q: 'plan' } },
			'What are my tasks?': { tool: 'search_tasks', args: { q: 'today' } },
			'Search my notes for the budget': { tool: 'search_notes', args: { q: 'budget' } }
		});
		let seen = r.questions().length;
		await r.client.sendText(r.room, 'Find my plan in my drive');
		await r.nextQuestion(seen);
		let acknowledged = r.saying('All right').length;
		await r.client.sendText(r.room, 'No.');
		await r.nextSaying('All right', acknowledged);

		seen = r.questions().length;
		await r.client.sendText(r.room, 'What are my tasks?');
		const question = await r.nextQuestion(seen);
		acknowledged = r.saying('All right').length;
		await r.client.react(r.room, question, '❌');
		await r.nextSaying('All right', acknowledged);

		seen = r.questions().length;
		await r.client.sendText(r.room, 'Search my notes for the budget');
		await r.nextQuestion(seen);
		const found = r.saying('Found:').length;
		await r.client.sendText(r.room, 'yes');
		await r.nextSaying('Found:', found);

		const answer = (domain: string, says: string, via: string): Record<string, string> => ({
			...firstRead(domain),
			answer: says,
			via,
			outcome: 'decided'
		});
		expect(await scraped(matrix, ANSWERS, answer('drive', 'no', 'words'), 1)).toBe(1);
		expect(await scraped(matrix, ANSWERS, answer('tasks', 'no', 'reaction'), 1)).toBe(1);
		expect(await scraped(matrix, ANSWERS, answer('notes', 'yes', 'words'), 1)).toBe(1);
		expect(await scraped(api, REPLAYS, { ...firstRead('notes'), outcome: 'ok' }, 1)).toBe(1);
		// A refused call runs nothing
		expect(total(await api(), REPLAYS, { domain: 'drive' })).toBe(0);
		expect(total(await api(), REPLAYS, { domain: 'tasks' })).toBe(0);
	});

	it('counts a replay the application fails as failed', async () => {
		r.h.apisix.contracts.handler = () => ({ status: 503, body: { error: 'unavailable' } });
		r.h.apisix.llm.script = modelFor({
			'Look for the party in my photos': { tool: 'search_photos', args: { q: 'party' } }
		});
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Look for the party in my photos');
		const question = await r.nextQuestion(seen);
		const heard = r.saying('Heard:').length;
		await r.client.react(r.room, question, '✅');
		// The model reads what the application answered
		expect(await r.nextSaying('Heard:', heard)).toContain('"status":503');
		expect(await scraped(api, REPLAYS, { ...firstRead('photos'), outcome: 'failed' }, 1)).toBe(1);
		expect(total(await api(), REPLAYS, { domain: 'photos', outcome: 'ok' })).toBe(0);
	});

	it('counts a request a newer one supersedes, and my answer that came too late for it', async () => {
		r.h.apisix.llm.script = modelFor({
			'Find the minutes in my wiki': { tool: 'search_wiki', args: { q: 'minutes' } },
			'Look in my contacts instead': { tool: 'search_contacts', args: { q: 'minutes' } }
		});
		let seen = r.questions().length;
		await r.client.sendText(r.room, 'Find the minutes in my wiki');
		const older = await r.nextQuestion(seen);
		seen = r.questions().length;
		await r.client.sendText(r.room, 'Look in my contacts instead');
		await r.nextQuestion(seen);
		expect(await scraped(matrix, SUPERSESSIONS, firstRead('wiki'), 1)).toBe(1);
		const notices = r.saying('A newer request').length;
		await r.client.react(r.room, older, '✅ YES');
		await r.nextSaying('A newer request', notices);
		const late = { ...firstRead('wiki'), answer: 'yes', via: 'reaction', outcome: 'superseded' };
		expect(await scraped(matrix, ANSWERS, late, 1)).toBe(1);
		// It decided nothing, and nothing ran
		expect(total(await matrix(), ANSWERS, { domain: 'wiki', outcome: 'decided' })).toBe(0);
		expect(total(await api(), REPLAYS, { domain: 'wiki' })).toBe(0);
		expect(total(await matrix(), SUPERSESSIONS, { domain: 'contacts' })).toBe(0);
	});

	it('labels its counters by application, level, reason and answer, never by me or my words', async () => {
		// What the conversations above left on the counters of both roles
		const texts = [...(await api()), ...(await matrix())];
		const counted = texts.flatMap(samplesOf).filter((s) => s.name.startsWith('harness_consent_'));
		expect(new Set(counted.map((s) => s.name))).toEqual(
			new Set([REQUESTS, ANSWERS, SUPERSESSIONS, REPLAYS])
		);
		// Every label is one of these, and takes one of the values the conversations gave it
		const labels = new Set(['domain', 'level', 'reason', 'answer', 'via', 'outcome']);
		const values = new Set([
			...DOMAINS,
			...['read', 'consent', 'yes', 'no', 'reaction', 'words'],
			...['decided', 'superseded', 'ok', 'failed']
		]);
		for (const sample of counted) {
			for (const [label, value] of Object.entries(sample.labels)) {
				expect(labels.has(label), label).toBe(true);
				expect(values.has(value), value).toBe(true);
			}
		}
		const lines = texts.flatMap((text) => text.split('\n'));
		const consent = lines.filter((line) => line.includes('harness_consent_'));
		for (const line of consent) {
			expect(line).not.toContain('alice');
			expect(line).not.toContain(r.room);
			expect(line).not.toContain('budget');
		}
	});
});

describe('an operator sees requests expire', () => {
	let r: ConsentRoom;
	const api = (): Promise<string[]> => apiMetrics(r);
	const matrix = (): Promise<string[]> => matrixMetrics(r);
	beforeAll(async () => {
		// A request's lifetime is a second here, and a day by default
		r = await startConsentRoom({ CONSENT_REQUEST_LIFETIME_MS: '1000' });
		r.h.apisix.contracts.spec = readCatalog(['mail', 'drive', 'notes']);
		for (const app of r.h.apps) expect(await app.agent.contracts.load()).toBe(3);
		r.h.apisix.contracts.handler = (c) => ({ status: 200, body: { found: c.path } });
	}, 240_000);
	afterAll(async () => {
		if (r !== undefined) await r.close();
	});

	it('counts on the matrix role a request my late answer finds expired, and that answer', async () => {
		r.h.apisix.llm.script = modelUsing('search_mail', { q: 'budget' });
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Find the budget in my mail');
		const question = await r.nextQuestion(seen);
		await sleep(1500);
		const notices = r.saying('This request has expired').length;
		await r.client.react(r.room, question, '✅ YES');
		await r.nextSaying('This request has expired', notices);
		expect(await scraped(matrix, EXPIRIES, firstRead('mail'), 1)).toBe(1);
		const late = { ...firstRead('mail'), answer: 'yes', via: 'reaction', outcome: 'expired' };
		expect(await scraped(matrix, ANSWERS, late, 1)).toBe(1);
		expect(total(await api(), EXPIRIES, {})).toBe(0);
		expect(total(await api(), REPLAYS, {})).toBe(0);
	});

	it('counts my late answer once per request, and tells me once, however many times I tap', async () => {
		r.h.apisix.llm.script = modelUsing('search_notes', { q: 'minutes' });
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Search my notes for the minutes');
		const question = await r.nextQuestion(seen);
		await sleep(1500);
		const notices = r.saying('This request has expired').length;
		const read = (): number =>
			r.h.logLines().filter((line) => line['msg'] === 'answer to a closed request').length;
		const answers = read();
		await r.client.react(r.room, question, '✅ YES');
		await r.nextSaying('This request has expired', notices);
		await r.client.react(r.room, question, '❌ NO');
		// The matrix role read my second tap...
		for (let i = 0; i < 120 && read() < answers + 2; i += 1) await sleep(250);
		expect(read()).toBe(answers + 2);
		// ...and whatever it says of it comes before its answer to my next message
		r.h.apisix.llm.script = () => ({ content: 'Noted.' });
		const noted = r.saying('Noted.').length;
		await r.client.sendText(r.room, 'Never mind');
		await r.nextSaying('Noted.', noted);
		expect(total(await matrix(), ANSWERS, { ...firstRead('notes'), outcome: 'expired' })).toBe(1);
		expect(r.saying('This request has expired')).toHaveLength(notices + 1);
	});

	it('counts on the worker role the requests its hourly pass expires', async () => {
		r.h.apisix.llm.script = modelUsing('search_drive', { q: 'plan' });
		const seen = r.questions().length;
		await r.client.sendText(r.room, 'Find my plan in my drive');
		await r.nextQuestion(seen);
		await sleep(1500);
		// The worker role, started as in production: its pass runs at once
		const worker = await startWorkerRole({
			config: { ...r.h.config, role: 'worker' },
			db: r.h.db,
			logStream: new Writable({ write: (_chunk, _encoding, done) => done() })
		});
		try {
			const scrape = async (): Promise<string[]> => [
				(await worker.app.inject({ method: 'GET', url: '/metrics' })).body
			];
			expect(await scraped(scrape, EXPIRIES, firstRead('drive'), 1)).toBe(1);
		} finally {
			await worker.stop();
		}
		expect(total(await matrix(), EXPIRIES, { domain: 'drive' })).toBe(0);
	});
});
