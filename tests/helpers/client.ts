import type { InjectOptions } from 'fastify';

import type { TestHarness } from './app.js';

export interface Reply<T = Record<string, unknown>> {
	readonly status: number;
	readonly body: T;
}

export interface TestClient {
	get<T = Record<string, unknown>>(sub: string, url: string): Promise<Reply<T>>;
	post<T = Record<string, unknown>>(
		sub: string,
		url: string,
		payload: Record<string, unknown>
	): Promise<Reply<T>>;
	put<T = Record<string, unknown>>(
		sub: string,
		url: string,
		payload: Record<string, unknown>
	): Promise<Reply<T>>;
	delete<T = Record<string, unknown>>(sub: string, url: string): Promise<Reply<T>>;
	tool<T = Record<string, unknown>>(
		sub: string,
		tool: string,
		args: Record<string, unknown>
	): Promise<Reply<T>>;
}

// A thin client over the HTTP boundary: every call carries a token minted for `sub`.
export function makeClient(h: TestHarness): TestClient {
	async function call<T>(
		sub: string,
		method: 'GET' | 'POST' | 'PUT' | 'DELETE',
		url: string,
		payload?: Record<string, unknown>
	): Promise<Reply<T>> {
		const options: InjectOptions = {
			method,
			url,
			headers: { authorization: `Bearer ${await h.issuer.mint({ sub })}` }
		};
		if (payload !== undefined) options.payload = payload;
		const res = await h.app.inject(options);
		const body = res.body.length === 0 ? ({} as T) : (res.json() as T);
		return { status: res.statusCode, body };
	}
	return {
		get: (sub, url) => call(sub, 'GET', url),
		post: (sub, url, payload) => call(sub, 'POST', url, payload),
		put: (sub, url, payload) => call(sub, 'PUT', url, payload),
		delete: (sub, url) => call(sub, 'DELETE', url),
		tool: (sub, tool, args) => call(sub, 'POST', '/v1/tool', { tool, arguments: args })
	};
}
