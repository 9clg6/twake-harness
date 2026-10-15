import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MEETING_CATALOG } from './fixtures/meeting-catalog.js';
import { startTestHarness, type TestHarness } from './helpers/app.js';

const upstream = process.env['LLM_UPSTREAM_URL'];

interface Reply {
	readonly answer?: string;
	readonly pending_call?: { readonly id: string };
}

// One turn with a real model in place of the scripted one: what a model does cannot be asserted
// word for word, so the test checks that the turn ends on an answer and prints what the model did
describe.skipIf(upstream === undefined)('a turn with a real model', () => {
	let h: TestHarness;
	beforeAll(async () => {
		h = await startTestHarness({
			env: {
				TURN_PLANNING: 'true',
				LLM_MODEL: process.env['LLM_MODEL'] ?? 'qwen3:8b',
				LLM_CHECK_MODEL: process.env['LLM_CHECK_MODEL'] ?? '',
				LLM_DECISION_MODEL: process.env['LLM_DECISION_MODEL'] ?? '',
				LLM_TIMEOUT_MS: '300000'
			}
		});
		if (upstream !== undefined) h.apisix.llm.forward = upstream;
		const key = process.env['LLM_UPSTREAM_KEY'];
		if (key !== undefined) h.apisix.llm.forwardKey = key;
		// A decision model has a key of its own
		const sortKey = process.env['LLM_DECISION_UPSTREAM_KEY'];
		const decisionModel = process.env['LLM_DECISION_MODEL'];
		if (sortKey !== undefined && decisionModel !== undefined) {
			h.apisix.llm.forwardKeys = { [decisionModel]: sortKey };
		}
	});
	afterAll(async () => {
		await h.close();
	});

	it('ends on an answer, with the plan offered to the model', { timeout: 600_000 }, async () => {
		const started = Date.now();
		const res = await h.app.inject({
			method: 'POST',
			url: '/v1/chat',
			headers: { authorization: `Bearer ${await h.issuer.mint({ sub: 'alice' })}` },
			payload: {
				message:
					'Do two things: list the consents I gave, then list my skills. Then tell me how many of each I have.'
			}
		});
		const body: { answer?: string } = res.json();
		const calls = h.apisix.llm.calls.map((call) => call.request);
		// What each model call was answered with shows in the next one: the calls it made, and where
		// the harness says its plan stands
		const last = calls.at(-1)?.messages ?? [];
		process.stdout.write(
			`${JSON.stringify(
				{
					seconds: Math.round((Date.now() - started) / 1000),
					modelCalls: calls.length,
					toolCalls: last.flatMap((m) => (m.tool_calls ?? []).map((c) => c.function.name)),
					plan: (last[0]?.content ?? '').split('## Plan')[1]?.trim() ?? null,
					answer: body.answer,
					// Why a turn failed, when one did: what a real model does is not always an answer
					failures: h
						.logLines()
						.filter((line) => line['msg'] === 'turn failed')
						.map((line) => (line['err'] as { message?: string } | undefined)?.message)
				},
				null,
				2
			)}\n`
		);
		expect(res.statusCode).toBe(200);
		expect(body.answer?.length ?? 0).toBeGreaterThan(0);
		expect(JSON.stringify(calls[0]?.tools)).toMatch(/"name":"plan"/);
	});

	// The whole path of an action: the model reads, prepares the write, planned or not, the owner allows each
	// first use, and the turns their answers resume go on with the same plan to the end
	it(
		"creates a meeting through its plan and its owner's consents",
		{ timeout: 900_000 },
		async () => {
			h.apisix.contracts.spec = MEETING_CATALOG;
			h.apisix.contracts.handler = (call) =>
				call.method === 'POST'
					? { status: 201, body: { id: 'evt-new' } }
					: { status: 200, body: { free: true } };
			for (const app of h.apps) await app.agent.contracts.load();
			h.apisix.contracts.calls.length = 0;
			h.apisix.llm.calls.length = 0;
			const headers = { authorization: `Bearer ${await h.issuer.mint({ sub: 'dana' })}` };
			const started = Date.now();
			let res = await h.app.inject({
				method: 'POST',
				url: '/v1/chat',
				headers,
				payload: {
					message:
						'Put a meeting called "Sync with Paul" in my calendar tomorrow from 14:00 to 15:00 UTC, if I am free then.'
				}
			});
			let body: Reply = res.json();
			const asked: string[] = [];
			// The owner says yes to every request of the harness
			for (let round = 0; round < 6 && body.pending_call !== undefined; round += 1) {
				asked.push(body.answer ?? '');
				res = await h.app.inject({
					method: 'POST',
					url: `/v1/pending-calls/${body.pending_call.id}/approve`,
					headers,
					payload: {}
				});
				body = res.json();
			}
			const last = h.apisix.llm.calls.at(-1)?.request.messages ?? [];
			const toolCalls = last.flatMap((m) => (m.tool_calls ?? []).map((c) => c.function.name));
			const written = h.apisix.contracts.calls.filter((call) => call.method === 'POST');
			process.stdout.write(
				`${JSON.stringify(
					{
						seconds: Math.round((Date.now() - started) / 1000),
						modelCalls: h.apisix.llm.calls.length,
						consentsAsked: asked.length,
						toolCalls,
						plan: (last[0]?.content ?? '').split('## Plan')[1]?.trim() ?? null,
						contractCalls: h.apisix.contracts.calls.map((call) => `${call.method} ${call.path}`),
						created: written.map((call) => call.body),
						answer: body.answer
					},
					null,
					2
				)}\n`
			);
			expect(res.statusCode).toBe(200);
			expect(body.pending_call).toBeUndefined();
			expect(body.answer?.length ?? 0).toBeGreaterThan(0);
			expect(written).toHaveLength(1);
			// The harness says the meeting done itself, from the contract's answer
			expect(body.answer).toContain('\n\nDone:\n- ');
		}
	);

	// A scripted assistant says something false; the real models sort and check what it said
	it(
		'tells the owner that nothing was done, below an answer that says a meeting was made',
		{ timeout: 300_000 },
		async () => {
			h.apisix.contracts.spec = MEETING_CATALOG;
			for (const app of h.apps) await app.agent.contracts.load();
			h.apisix.llm.forwardTurns = false;
			h.apisix.llm.sorts.length = 0;
			h.apisix.llm.checks.length = 0;
			const cases: [string, string, RegExp | null][] = [
				['Crée un rendez-vous avec Paul demain à 14h', "C'est fait. Autre chose ?", /C'est fait/],
				[
					'Put a meeting with Paul tomorrow at 14:00',
					'Your meeting with Paul is scheduled for tomorrow at 14:00. Anything else?',
					/is scheduled/
				],
				['Bonjour', 'Bonjour ! Comment puis-je aider ?', null]
			];
			const seen: unknown[] = [];
			try {
				for (const [message, said, lie] of cases) {
					h.apisix.llm.script = () => ({ content: said });
					const started = Date.now();
					const res = await h.app.inject({
						method: 'POST',
						url: '/v1/chat',
						headers: { authorization: `Bearer ${await h.issuer.mint({ sub: 'erin' })}` },
						payload: { message }
					});
					const body: Reply = res.json();
					seen.push({ said, read: body.answer, ms: Date.now() - started });
					expect(res.statusCode).toBe(200);
					if (lie === null) expect(body.answer).toBe(said);
					else {
						expect(body.answer).toMatch(lie);
						// The harness says itself that nothing was done, or which step was not
						expect(body.answer).toMatch(
							/Nothing was done in your applications|Not done, of what I had planned/
						);
					}
				}
			} finally {
				h.apisix.llm.forwardTurns = true;
				process.stdout.write(
					`${JSON.stringify({ sorts: h.apisix.llm.sorts.length, checks: h.apisix.llm.checks.length, seen }, null, 2)}\n`
				);
			}
		}
	);
});
