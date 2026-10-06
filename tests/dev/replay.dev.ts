import { describe, expect, it } from 'vitest';

// The prototype's black-box checks, replayed against a deployed harness through its gateway:
// HARNESS_BASE_URL is the api route (for instance https://apisix.dev.twake.lin-saas.com/agents),
// HARNESS_TOKEN_A and HARNESS_TOKEN_B the access tokens of two users, audience twake-harness.
const base = process.env['HARNESS_BASE_URL']?.replace(/\/+$/, '');
const tokenA = process.env['HARNESS_TOKEN_A'];
const tokenB = process.env['HARNESS_TOKEN_B'];
const configured = base !== undefined && tokenA !== undefined && tokenB !== undefined;

interface Reply<T = Record<string, unknown>> {
	readonly status: number;
	readonly body: T;
}

async function call<T = Record<string, unknown>>(
	token: string | null,
	method: 'GET' | 'POST',
	path: string,
	body?: Record<string, unknown>
): Promise<Reply<T>> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (token !== null) headers['authorization'] = `Bearer ${token}`;
	const res = await fetch(`${base ?? ''}${path}`, {
		method,
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(110_000)
	});
	const text = await res.text();
	return { status: res.status, body: parseBody(text) as T };
}

function parseBody(text: string): unknown {
	try {
		return text.length === 0 ? {} : JSON.parse(text);
	} catch {
		return { raw: text.slice(0, 200) };
	}
}

const DEFAULT_ACTIONS = [
	'chat',
	'sessions.read_own',
	'skills.read_own',
	'memory.read_own',
	'memory.write_own',
	'contracts.call',
	'contracts.act'
];

describe.skipIf(!configured)('the harness on dev, as the prototype suites checked it', () => {
	const a = tokenA ?? '';
	const b = tokenB ?? '';
	const stamp = `replay-${Date.now()}`;
	let sessionOfA = '';

	it('answers the health check without any token', async () => {
		expect((await call(null, 'GET', '/health')).status).toBe(200);
	});

	it('provisions both users with the default rights on their first request', async () => {
		const me = await call<{ user: string; actions: string[] }>(a, 'GET', '/v1/me');
		const other = await call<{ user: string; actions: string[] }>(b, 'GET', '/v1/me');
		expect(me.status).toBe(200);
		expect(other.status).toBe(200);
		expect(me.body.user).not.toBe(other.body.user);
		for (const action of DEFAULT_ACTIONS) {
			expect(me.body.actions).toContain(action);
			expect(other.body.actions).toContain(action);
		}
	});

	it('refuses a missing or tampered token', async () => {
		expect((await call(null, 'GET', '/v1/me')).status).toBe(401);
		const [header, payload] = a.split('.');
		expect((await call(`${header}.${payload}.AAAA`, 'GET', '/v1/me')).status).toBe(401);
	});

	it('keeps the memory of one user out of the reach of the other', async () => {
		const added = await call(a, 'POST', '/v1/tool', {
			tool: 'memory',
			arguments: { action: 'add', target: 'memory', content: `${stamp} belongs to the first user` }
		});
		expect(added.status).toBe(200);
		const mine = await call<{ memory: string[] }>(a, 'GET', '/v1/memory');
		const theirs = await call<{ memory: string[] }>(b, 'GET', '/v1/memory');
		expect(mine.body.memory.some((entry) => entry.includes(stamp))).toBe(true);
		expect(theirs.body.memory.some((entry) => entry.includes(stamp))).toBe(false);
	});

	it('refuses an identity override in a tool call', async () => {
		const forged = await call<{ error?: string }>(a, 'POST', '/v1/tool', {
			tool: 'memory',
			arguments: { action: 'add', target: 'memory', content: `${stamp} forged`, principal: 'other' }
		});
		// Either refused outright, or refused by the tool, which names the argument it does not take
		expect(forged.status === 400 || typeof forged.body.error === 'string').toBe(true);
		const theirs = await call<{ memory: string[] }>(b, 'GET', '/v1/memory');
		expect(theirs.body.memory.some((entry) => entry.includes(`${stamp} forged`))).toBe(false);
	});

	it('isolates the sessions: the other user can neither read, search nor continue one', async () => {
		const chat = await call<{ session_id: string; answer: string }>(a, 'POST', '/v1/chat', {
			message: `Reply with the single word pong, then the word ${stamp}.`
		});
		expect(chat.status).toBe(200);
		expect(chat.body.answer.length).toBeGreaterThan(0);
		sessionOfA = chat.body.session_id;
		expect((await call(b, 'GET', `/v1/sessions/${sessionOfA}`)).status).toBe(404);
		const search = await call<{ sessions: { session_id: string }[] }>(b, 'POST', '/v1/tool', {
			tool: 'session_search',
			arguments: { query: stamp }
		});
		expect(search.status).toBe(200);
		expect((search.body.sessions ?? []).some((s) => s.session_id === sessionOfA)).toBe(false);
		const continued = await call(b, 'POST', '/v1/chat', {
			session_id: sessionOfA,
			message: 'and now?'
		});
		expect(continued.status).toBe(404);
		expect((await call(a, 'GET', `/v1/sessions/${sessionOfA}`)).status).toBe(200);
	});

	it('serves two users at once, each in their own session', async () => {
		const [first, second] = await Promise.all([
			call<{ session_id: string; answer: string }>(a, 'POST', '/v1/chat', {
				message: 'Reply with the single word ping.'
			}),
			call<{ session_id: string; answer: string }>(b, 'POST', '/v1/chat', {
				message: 'Reply with the single word pong.'
			})
		]);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(first.body.session_id).not.toBe(second.body.session_id);
		expect(first.body.answer.length).toBeGreaterThan(0);
		expect(second.body.answer.length).toBeGreaterThan(0);
	});
});
