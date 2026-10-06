import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
	name?: string;
}

export interface ToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	tools?: unknown[];
	max_tokens?: number;
}

export interface ScriptedReply {
	content?: string | null;
	reasoning?: string;
	toolCalls?: ToolCall[];
	delayMs?: number;
}

export type LlmScript = (request: ChatRequest, callIndex: number) => ScriptedReply;

export interface RecordedCall {
	readonly startedAt: number;
	readonly finishedAt: number;
	readonly apiKey: string | null;
	readonly request: ChatRequest;
}

export interface ContractCall {
	readonly method: string;
	readonly path: string;
	readonly query: Record<string, string>;
	readonly headers: Record<string, string>;
	readonly body: unknown;
}

export interface ContractReply {
	readonly status: number;
	readonly body: unknown;
}

export interface FakeApisix {
	readonly baseUrl: string;
	readonly consumerKey: string;
	readonly llm: {
		calls: RecordedCall[];
		script: LlmScript;
	};
	// The contract catalog APISIX serves, the contracts' behaviour, and the audit route
	readonly contracts: {
		spec: unknown;
		calls: ContractCall[];
		handler: (call: ContractCall) => ContractReply;
	};
	readonly audit: unknown[];
	// Where the /matrix route forwards, once a homeserver is up
	matrixUpstream: string | null;
	close(): Promise<void>;
}

function lastUserContent(request: ChatRequest): string {
	for (let i = request.messages.length - 1; i >= 0; i -= 1) {
		const message = request.messages[i];
		if (message !== undefined && message.role === 'user' && message.content !== null) {
			return message.content;
		}
	}
	return '';
}

// The default script answers like a very literal model: it echoes the last user message.
export const echoScript: LlmScript = (request) => ({
	content: `echo: ${lastUserContent(request)}`
});

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify(body));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startFakeApisix(): Promise<FakeApisix> {
	const consumerKey = 'test-consumer-key';
	const llm: FakeApisix['llm'] = { calls: [], script: echoScript };
	const fake = { matrixUpstream: null as string | null };
	const contracts: FakeApisix['contracts'] = {
		spec: null,
		calls: [],
		handler: () => ({ status: 200, body: { ok: true } })
	};
	const audit: unknown[] = [];
	const server: Server = createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://fake');
		const apiKeyHeader = req.headers['apikey'];
		const apiKey = typeof apiKeyHeader === 'string' ? apiKeyHeader : null;
		if (apiKey !== consumerKey) {
			sendJson(res, 401, { message: 'Missing API key found in request' });
			return;
		}
		if (url.pathname.startsWith('/matrix/')) {
			if (fake.matrixUpstream === null) {
				sendJson(res, 502, { error: 'no matrix upstream' });
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			const target = `${fake.matrixUpstream}${url.pathname.slice('/matrix'.length)}${url.search}`;
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(req.headers)) {
				if (
					typeof value === 'string' &&
					!['host', 'apikey', 'content-length', 'connection'].includes(name)
				) {
					headers[name] = value;
				}
			}
			const upstream = await fetch(target, {
				method: req.method ?? 'GET',
				headers,
				...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) })
			});
			res.statusCode = upstream.status;
			res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
			res.end(Buffer.from(await upstream.arrayBuffer()));
			return;
		}
		if (req.method === 'GET' && url.pathname === '/contracts/openapi.json') {
			if (contracts.spec === null) {
				sendJson(res, 404, { error: 'no catalog' });
				return;
			}
			sendJson(res, 200, contracts.spec);
			return;
		}
		if (url.pathname.startsWith('/contracts/')) {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			const text = Buffer.concat(chunks).toString('utf8');
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(req.headers)) {
				if (typeof value === 'string') headers[name] = value;
			}
			const call: ContractCall = {
				method: req.method ?? 'GET',
				path: url.pathname.slice('/contracts'.length),
				query: Object.fromEntries(url.searchParams.entries()),
				headers,
				body: text.length === 0 ? null : (JSON.parse(text) as unknown)
			};
			contracts.calls.push(call);
			const reply = contracts.handler(call);
			sendJson(res, reply.status, reply.body);
			return;
		}
		if (req.method === 'POST' && url.pathname === '/audit') {
			audit.push(await readJson(req));
			sendJson(res, 200, {});
			return;
		}
		if (req.method === 'POST' && url.pathname === '/llm/v1/chat/completions') {
			const startedAt = Date.now();
			const request = (await readJson(req)) as ChatRequest;
			const reply = llm.script(request, llm.calls.length);
			if (reply.delayMs !== undefined) await sleep(reply.delayMs);
			llm.calls.push({ startedAt, finishedAt: Date.now(), apiKey, request });
			const message: Record<string, unknown> = {
				role: 'assistant',
				content: reply.content ?? null
			};
			if (reply.reasoning !== undefined) message['reasoning_content'] = reply.reasoning;
			if (reply.toolCalls !== undefined) message['tool_calls'] = reply.toolCalls;
			sendJson(res, 200, {
				id: `chatcmpl-${llm.calls.length}`,
				object: 'chat.completion',
				model: request.model,
				choices: [
					{
						index: 0,
						message,
						finish_reason: reply.toolCalls === undefined ? 'stop' : 'tool_calls'
					}
				],
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
			});
			return;
		}
		sendJson(res, 404, { error: 'no route' });
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('fake apisix did not bind to a TCP port');
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		consumerKey,
		llm,
		contracts,
		audit,
		get matrixUpstream() {
			return fake.matrixUpstream;
		},
		set matrixUpstream(value: string | null) {
			fake.matrixUpstream = value;
		},
		close: () =>
			new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
	};
}
