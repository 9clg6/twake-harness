import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '../config.js';
import type { Tool } from '../agent/tools.js';
import type { ConsentMetrics } from '../consents/metrics.js';
import { readDomains, type DomainDescriptions } from './domains.js';
import { parseContracts, readServer, type ContractDefinition } from './openapi.js';
import { makeContractTool } from './tools.js';

export interface ContractCatalog {
	readonly tools: readonly Tool[];
	readonly contracts: readonly ContractDefinition[];
	// How the catalog names the applications to their owners
	readonly domainDescriptions: DomainDescriptions;
	load(): Promise<number>;
	stop(): void;
}

export interface CatalogDeps {
	readonly config: Config;
	readonly log: FastifyBaseLogger;
	readonly fetchImpl?: typeof fetch;
	readonly consentMetrics: ConsentMetrics;
}

// The contracts the gateway serves, turned into tools at start and refreshed on an interval; a
// failed refresh keeps the previous catalog.
export function makeContractCatalog(deps: CatalogDeps): ContractCatalog {
	const { config, log, consentMetrics } = deps;
	const fetchImpl = deps.fetchImpl ?? fetch;
	let contracts: ContractDefinition[] = [];
	let tools: Tool[] = [];
	let descriptions: DomainDescriptions = new Map();
	let timer: NodeJS.Timeout | null = null;
	// The foreign hosts a document named, warned about once each
	const warnedOrigins = new Set<string>();
	// The descriptions of applications left out for their shape, warned about once each
	const warnedDescriptions = new Set<string>();
	// The writes whose risk the document gave a value the harness does not know, warned about once
	// each
	const warnedRisks = new Set<string>();
	// The operations whose preview the harness does not follow, warned about once each
	const warnedPreviews = new Set<string>();

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
			const document: unknown = await response.json();
			const { contracts: parsed, unknownRisks, ignoredPreviews } = parseContracts(document);
			const server = readServer(document);
			// A server on another host does not take the calls there: only its path is kept
			if (
				server.origin !== null &&
				server.origin !== config.apisix.baseUrl.origin &&
				!warnedOrigins.has(server.origin)
			) {
				warnedOrigins.add(server.origin);
				log.warn(
					{ server: server.origin, path: server.path },
					'contracts server is another host, calls stay on the gateway'
				);
			}
			// How the questions name the applications: an entry of another shape is left out, and
			// its application named by its id, without failing the catalog
			const domains = readDomains(document);
			for (const { domain, problem } of domains.ignored) {
				const key = `${domain ?? ''}\n${problem}`;
				if (warnedDescriptions.has(key)) continue;
				warnedDescriptions.add(key);
				log.warn({ domain, problem }, 'domain description ignored, named by its id');
			}
			// A write whose risk is neither low nor high is confirmed call by call, as a high one is:
			// the mistake costs its owners a question, and its operator learns of it
			for (const { contract, declared } of unknownRisks) {
				const key = `${contract}\n${JSON.stringify(declared)}`;
				if (warnedRisks.has(key)) continue;
				warnedRisks.add(key);
				log.warn({ contract, declared }, 'contract risk unknown, treated as high');
			}
			// An operation that declares a preview the harness does not follow is asked about with the
			// call as the model wrote it, as one without a preview is: its operator learns why
			for (const { contract, declared } of ignoredPreviews) {
				const key = `${contract}\n${JSON.stringify(declared)}`;
				if (warnedPreviews.has(key)) continue;
				warnedPreviews.add(key);
				log.warn({ contract, declared }, 'contract preview ignored');
			}
			contracts = parsed;
			descriptions = domains.descriptions;
			tools = parsed.map((contract) =>
				makeContractTool(contract, {
					config,
					log,
					fetchImpl,
					serverPath: server.path,
					consentMetrics,
					domains: domains.descriptions
				})
			);
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
		get domainDescriptions() {
			return descriptions;
		},
		load,
		stop: () => {
			if (timer !== null) clearInterval(timer);
		}
	};
}
