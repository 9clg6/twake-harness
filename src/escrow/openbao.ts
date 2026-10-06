import { readFile } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '../config.js';

export type EscrowSecrets = Readonly<Record<string, string>>;

export interface EscrowStore {
	// The OpenBao path of an owner's secrets, kept as a reference in the database
	pathOf(owner: string): string;
	write(owner: string, secrets: EscrowSecrets): Promise<void>;
	read(owner: string): Promise<EscrowSecrets | null>;
}

export interface EscrowStoreDeps {
	readonly config: Config;
	readonly log: FastifyBaseLogger;
	readonly fetchImpl?: typeof fetch;
}

function parseJson(text: string): unknown {
	try {
		return text.length === 0 ? null : JSON.parse(text);
	} catch {
		return null;
	}
}

function joinPath(base: URL, ...parts: string[]): URL {
	const root = base.href.endsWith('/') ? base.href : `${base.href}/`;
	return new URL(parts.map((part) => part.replace(/^\/+|\/+$/g, '')).join('/'), root);
}

// The platform OpenBao, reached through the openbao route of APISIX and authenticated with the
// pod's Kubernetes identity. Every read and write is logged with the principal it concerns.
export function makeOpenBaoEscrow(deps: EscrowStoreDeps): EscrowStore {
	const { config, log } = deps;
	const fetchImpl = deps.fetchImpl ?? fetch;
	const { escrow } = config;
	let token: { value: string; expiresAt: number } | null = null;

	async function login(): Promise<string> {
		if (token !== null && token.expiresAt > Date.now() + 30_000) return token.value;
		const jwt = (await readFile(escrow.k8sTokenPath, 'utf8')).trim();
		const url = joinPath(config.apisix.baseUrl, escrow.path, 'v1', escrow.authPath);
		const response = await fetchImpl(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', apikey: config.apisix.consumerKey },
			body: JSON.stringify({ role: escrow.k8sRole, jwt })
		});
		if (!response.ok) throw new Error(`OpenBao login refused: HTTP ${response.status}`);
		const body = (await response.json()) as {
			auth?: { client_token?: string; lease_duration?: number };
		};
		const value = body.auth?.client_token;
		if (typeof value !== 'string' || value.length === 0) {
			throw new Error('OpenBao login returned no token');
		}
		token = { value, expiresAt: Date.now() + (body.auth?.lease_duration ?? 600) * 1000 };
		log.info({ role: escrow.k8sRole }, 'escrow login');
		return value;
	}

	function pathOf(owner: string): string {
		return `${escrow.kvMount}/data/${escrow.prefix}/${encodeURIComponent(owner)}`;
	}

	async function call(
		owner: string,
		operation: 'write' | 'read',
		method: 'POST' | 'GET',
		body?: unknown
	): Promise<{ status: number; body: unknown }> {
		const vaultToken = await login();
		const url = joinPath(config.apisix.baseUrl, escrow.path, 'v1', pathOf(owner));
		const response = await fetchImpl(url, {
			method,
			headers: {
				'content-type': 'application/json',
				apikey: config.apisix.consumerKey,
				'x-vault-token': vaultToken
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		});
		const parsed = parseJson(await response.text());
		log.info(
			{ principal: owner, operation, path: pathOf(owner), status: response.status },
			`escrow ${operation}`
		);
		return { status: response.status, body: parsed };
	}

	return {
		pathOf,
		write: async (owner, secrets) => {
			const result = await call(owner, 'write', 'POST', { data: secrets });
			if (result.status < 200 || result.status >= 300) {
				throw new Error(`escrow write refused: HTTP ${result.status}`);
			}
		},
		read: async (owner) => {
			const result = await call(owner, 'read', 'GET');
			if (result.status === 404) return null;
			if (result.status < 200 || result.status >= 300) {
				throw new Error(`escrow read refused: HTTP ${result.status}`);
			}
			const data = (result.body as { data?: { data?: Record<string, unknown> } } | null)?.data
				?.data;
			if (data === undefined || data === null) return null;
			const secrets: Record<string, string> = {};
			for (const [key, value] of Object.entries(data)) {
				if (typeof value === 'string') secrets[key] = value;
			}
			return secrets;
		}
	};
}
