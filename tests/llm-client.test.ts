import { beforeEach, describe, expect, it } from 'vitest';

import { LlmError, makeLlmClient, type LlmClient } from '../src/llm/client.js';

// What the client logged of the calls that failed
const logged: Record<string, unknown>[] = [];
const log = {
	warn(fields: Record<string, unknown>, msg: string): void {
		logged.push({ ...fields, msg });
	}
};

// A client of a gateway that answers as the test says, with the time its calls have to answer in
function clientOf(fetchImpl: typeof fetch, timeoutMs = 1_000): LlmClient {
	return makeLlmClient({
		baseUrl: new URL('http://gateway.test/'),
		consumerKey: 'key',
		model: 'a-model',
		maxTokens: 16,
		timeoutMs,
		fetchImpl,
		log
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const ask = (client: LlmClient): ReturnType<LlmClient['complete']> =>
	client.complete([{ role: 'user', content: 'Hello' }], []);

describe('the client of a model', () => {
	beforeEach(() => {
		logged.length = 0;
	});

	// The time of a call runs until its answer is read: a gateway that sends its headers at once and
	// its body later is one that took that long
	it('reads what the model answered, and tells how long the call took, its body included', async () => {
		const client = clientOf(
			async () =>
				new Response(
					new ReadableStream({
						async start(controller) {
							await sleep(50);
							controller.enqueue(
								new TextEncoder().encode(
									JSON.stringify({
										choices: [{ message: { content: 'Hi there' }, finish_reason: 'stop' }]
									})
								)
							);
							controller.close();
						}
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
		);
		const started = performance.now();
		const completion = await ask(client);
		const elapsedMs = performance.now() - started;
		expect(completion.content).toBe('Hi there');
		expect(completion.durationMs).toBeGreaterThanOrEqual(40);
		expect(completion.durationMs).toBeLessThanOrEqual(Math.ceil(elapsedMs));
		expect(logged).toEqual([]);
	});

	// A usage with one of its two counts is none: the callers spend what the model reports whole
	it('reads the calls of the model, and keeps no usage that is not whole', async () => {
		const client = clientOf(async () =>
			Response.json({
				choices: [
					{
						message: {
							content: null,
							tool_calls: [
								{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }
							]
						},
						finish_reason: 'tool_calls'
					}
				],
				usage: { prompt_tokens: 12 }
			})
		);
		const completion = await ask(client);
		expect(completion.toolCalls.map((call) => call.function.name)).toEqual(['read']);
		expect(completion.finishReason).toBe('tool_calls');
		expect(completion.usage).toBeNull();
		expect(completion.content).toBeNull();
	});

	// Every call that failed is logged here, once for every caller, with what went wrong and how
	// long it took: the calls that timed out are counted against those that answered
	it('fails as a model that failed when the gateway answers an error, logged with its status', async () => {
		const client = clientOf(async () => new Response('upstream down', { status: 503 }));
		const err = await ask(client).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LlmError);
		expect(err).toMatchObject({ kind: 'http', status: 503, durationMs: expect.any(Number) });
		expect(logged).toEqual([
			{
				model: 'a-model',
				kind: 'http',
				status: 503,
				durationMs: expect.any(Number),
				msg: 'model call failed'
			}
		]);
	});

	it('fails as a model that failed, timed out, when the gateway does not answer in time', async () => {
		const client = clientOf(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
				}),
			50
		);
		const err = await ask(client).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LlmError);
		expect(err).toMatchObject({ kind: 'timeout', status: undefined });
		expect((err as LlmError).durationMs).toBeGreaterThanOrEqual(40);
		expect(logged).toEqual([
			{
				model: 'a-model',
				kind: 'timeout',
				status: undefined,
				durationMs: expect.any(Number),
				msg: 'model call failed'
			}
		]);
	});

	// A gateway, or a proxy in front of it, may answer a page for people where the model's JSON was
	// due: that is a model that failed, which callers go on without, and not a bug that fails them
	it('fails as a model that failed when what it answered is not JSON', async () => {
		const client = clientOf(
			async () =>
				new Response('<html><body>502 Bad Gateway</body></html>', {
					status: 200,
					headers: { 'content-type': 'text/html' }
				})
		);
		await expect(ask(client)).rejects.toMatchObject({ kind: 'answer' });
	});

	// A body cut short is an answer that never came, not one of the wrong shape
	it('fails as a model that failed, on the network, when its answer is cut short', async () => {
		const client = clientOf(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"choices":['));
							controller.error(new TypeError('terminated'));
						}
					}),
					{ status: 200 }
				)
		);
		await expect(ask(client)).rejects.toMatchObject({ kind: 'network' });
		expect(logged).toEqual([
			{
				model: 'a-model',
				kind: 'network',
				status: undefined,
				durationMs: expect.any(Number),
				msg: 'model call failed'
			}
		]);
	});

	// The call has its time limit until its answer is read: a model that sends its headers and then
	// stalls is one that did not answer in time
	it('fails as a model that failed when its answer stops coming once it began', async () => {
		const client = clientOf(
			async (_input, init) =>
				new Response(
					new ReadableStream({
						start(controller) {
							// As fetch does when the signal of the call fires while the body is read
							init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
						}
					}),
					{ status: 200 }
				),
			50
		);
		await expect(ask(client)).rejects.toMatchObject({ kind: 'timeout' });
	});
});
