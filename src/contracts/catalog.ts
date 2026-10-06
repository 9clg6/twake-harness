import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '../config.js';
import type { Tool } from '../agent/tools.js';
import { parseContracts, type ContractDefinition } from './openapi.js';
import { makeContractTool } from './tools.js';

export interface ContractCatalog {
	readonly tools: readonly Tool[];
	readonly contracts: readonly ContractDefinition[];
	load(): Promise<number>;
	stop(): void;
}

export interface CatalogDeps {
	readonly config: Config;
	readonly log: FastifyBaseLogger;
	readonly fetchImpl?: typeof fetch;
}

// The contracts the gateway serves, turned into tools at start and refreshed on an interval; a
// failed refresh keeps the previous catalog.
export function makeContractCatalog(deps: CatalogDeps): ContractCatalog {
	const { config, log } = deps;
	const fetchImpl = deps.fetchImpl ?? fetch;
	let contracts: ContractDefinition[] = [];
	let tools: Tool[] = [];
	let timer: NodeJS.Timeout | null = null;

	async function load(): Promise<number> {
		const base = config.apisix.baseUrl.href.endsWith('/')
			? config.apisix.baseUrl.href
			: `${config.apisix.baseUrl.href}/`;
		const url = new URL(config.contracts.openapiPath, base);
		try {
			const response = await fetchImpl(url, {
				headers: { apikey: config.apisix.consumerKey },
				signal: AbortSignal.timeout(config.contracts.timeoutMs)
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const parsed = parseContracts(await response.json());
			contracts = parsed;
			tools = parsed.map((contract) => makeContractTool(contract, { config, log, fetchImpl }));
			log.info({ contracts: parsed.map((c) => c.id) }, 'contracts loaded');
		} catch (err: unknown) {
			log.warn({ url: url.href, err }, 'contracts not loaded, keeping the previous catalog');
		}
		return tools.length;
	}

	if (config.contracts.refreshMs > 0) {
		timer = setInterval(() => void load(), config.contracts.refreshMs);
		timer.unref();
	}

	return {
		get tools() {
			return tools;
		},
		get contracts() {
			return contracts;
		},
		load,
		stop: () => {
			if (timer !== null) clearInterval(timer);
		}
	};
}
