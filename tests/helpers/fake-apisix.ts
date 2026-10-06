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
	// Why the model stopped: stop or tool_calls unless told otherwise, such as length when it ran
	// out of tokens, in which case it reports the whole budget as spent
	finishReason?: string;
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
	// The whole path the gateway received, as APISIX matches its routes on it
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
	// The contract catalog APISIX serves, the contracts' behaviour, and the audit route. Like the
	// gateway, it forwards only what matches an operation of the catalog: its server path plus its
	// path, under `mount` when the gateway mounts the contracts under a prefix of its own.
	readonly contracts: {
		spec: unknown;
		mount: string;
		calls: ContractCall[];
		handler: (call: ContractCall) => ContractReply;
	};
	readonly audit: unknown[];
	// The OpenBao behind the openbao route: a Kubernetes login and one KV v2 mount, in memory
	readonly openbao: {
		readonly token: string;
		readonly podToken: string;
		readonly store: Map<string, Record<string, string>>;
		readonly calls: { method: string; path: string; status: number }[];
	};
	// Where the /matrix route forwards, once a homeserver is up
	matrixUpstream: string | null;
	// What went through the /matrix route, for diagnosis
	readonly matrixCalls: { method: string; path: string; status: number; ms: number }[];
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

interface ContractRoute {
	readonly method: string;
	readonly pattern: RegExp;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The routes a gateway publishes for a catalog, one per operation: the document's server path (its
// path part when the server is an absolute URL, the root when there is none) and the operation
// path, under the mount. A path parameter matches one segment.
function contractRoutes(spec: unknown, mount: string): ContractRoute[] {
	if (typeof spec !== 'object' || spec === null) return [];
	const document = spec as {
		servers?: { url?: unknown }[];
		paths?: Record<string, Record<string, unknown>>;
	};
	const server = document.servers?.[0]?.url;
	const serverUrl = typeof server === 'string' ? server : '/';
	const serverPath = /^[a-z][a-z0-9+.-]*:\/\//i.test(serverUrl)
		? new URL(serverUrl).pathname
		: serverUrl;
	const routes: ContractRoute[] = [];
	for (const [path, item] of Object.entries(document.paths ?? {})) {
		const full = [mount, serverPath, path]
			.map((segment) => segment.replace(/^\/+|\/+$/g, ''))
			.filter((segment) => segment.length > 0)
			.join('/');
		const pattern = new RegExp(
			`^/${full
				.split(/\{[^}]+\}/)
				.map(escapeRegExp)
				.join('[^/]+')}$`
		);
		for (const method of Object.keys(item).filter((key) => HTTP_METHODS.includes(key))) {
			routes.push({ method: method.toUpperCase(), pattern });
		}
	}
	return routes;
}

export async function startFakeApisix(): Promise<FakeApisix> {
	const consumerKey = 'test-consumer-key';
	const llm: FakeApisix['llm'] = { calls: [], script: echoScript };
	const fake = { matrixUpstream: null as string | null };
	const matrixCalls: FakeApisix['matrixCalls'] = [];
	const contracts: FakeApisix['contracts'] = {
		spec: null,
		mount: '',
		calls: [],
		handler: () => ({ status: 200, body: { ok: true } })
	};
	const audit: unknown[] = [];
	const openbao: FakeApisix['openbao'] = {
		token: 'bao-test-token',
		podToken: 'pod-service-account-token',
		store: new Map(),
		calls: []
	};
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
			const startedAt = Date.now();
			const path = url.pathname.slice('/matrix'.length) + url.search;
			// Like the real gateway, an upstream that fails or goes away mid-call is answered with a 502
			try {
				const upstream = await fetch(target, {
					method: req.method ?? 'GET',
					headers,
					...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) })
				});
				const body = Buffer.from(await upstream.arrayBuffer());
				matrixCalls.push({
					method: req.method ?? 'GET',
					path,
					status: upstream.status,
					ms: Date.now() - startedAt
				});
				res.statusCode = upstream.status;
				res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
				res.end(body);
			} catch {
				matrixCalls.push({
					method: req.method ?? 'GET',
					path,
					status: 502,
					ms: Date.now() - startedAt
				});
				if (!res.headersSent) sendJson(res, 502, { error: 'matrix upstream failed' });
				else res.destroy();
			}
			return;
		}
		if (url.pathname.startsWith('/openbao/')) {
			const path = url.pathname.slice('/openbao'.length);
			const record = (status: number): void => {
				openbao.calls.push({ method: req.method ?? '', path, status });
			};
			if (req.method === 'POST' && path === '/v1/auth/kubernetes/login') {
				const body = (await readJson(req)) as { role?: string; jwt?: string };
				if (body.jwt !== openbao.podToken || body.role !== 'twake-harness') {
					record(403);
					sendJson(res, 403, { errors: ['permission denied'] });
					return;
				}
				record(200);
				sendJson(res, 200, { auth: { client_token: openbao.token, lease_duration: 3600 } });
				return;
			}
			if (req.headers['x-vault-token'] !== openbao.token) {
				record(403);
				sendJson(res, 403, { errors: ['permission denied'] });
				return;
			}
			const match = /^\/v1\/secret\/data\/(.+)$/.exec(path);
			if (match === null || match[1] === undefined) {
				record(404);
				sendJson(res, 404, { errors: [] });
				return;
			}
			const key = decodeURIComponent(match[1]);
			if (req.method === 'POST') {
				const body = (await readJson(req)) as { data?: Record<string, string> };
				openbao.store.set(key, body.data ?? {});
				record(200);
				sendJson(res, 200, { data: { version: 1 } });
				return;
			}
			const data = openbao.store.get(key);
			if (data === undefined) {
				record(404);
				sendJson(res, 404, { errors: [] });
				return;
			}
			record(200);
			sendJson(res, 200, { data: { data, metadata: { version: 1 } } });
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
		const routed = contractRoutes(contracts.spec, contracts.mount).some(
			(route) => route.method === (req.method ?? 'GET') && route.pattern.test(url.pathname)
		);
		if (routed) {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			const text = Buffer.concat(chunks).toString('utf8');
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(req.headers)) {
				if (typeof value === 'string') headers[name] = value;
			}
			const call: ContractCall = {
				method: req.method ?? 'GET',
				path: url.pathname,
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
			// The relay takes one record or a batch; both are kept flat here
			const posted = await readJson(req);
			audit.push(...(Array.isArray(posted) ? posted : [posted]));
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
						finish_reason:
							reply.finishReason ?? (reply.toolCalls === undefined ? 'stop' : 'tool_calls')
					}
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: reply.finishReason === 'length' ? (request.max_tokens ?? 5) : 5,
					total_tokens: 15
				}
			});
			return;
		}
		// What APISIX answers when no route matches: the request goes nowhere
		sendJson(res, 404, { error_msg: '404 Route Not Found' });
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
		openbao,
		get matrixUpstream() {
			return fake.matrixUpstream;
		},
		set matrixUpstream(value: string | null) {
			fake.matrixUpstream = value;
		},
		matrixCalls,
		close: () =>
			new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
	};
}
