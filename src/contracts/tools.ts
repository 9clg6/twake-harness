import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '../config.js';
import type { LlmToolDefinition } from '../llm/client.js';
import type { Tool, ToolContext, ToolOutcome } from '../agent/tools.js';
import { toolParametersOf, type ContractDefinition } from './openapi.js';

export interface ContractToolDeps {
	readonly config: Config;
	readonly log: FastifyBaseLogger;
	readonly fetchImpl?: typeof fetch;
}

function joinPath(base: URL, ...segments: string[]): URL {
	const root = base.href.endsWith('/') ? base.href : `${base.href}/`;
	return new URL(segments.map((s) => s.replace(/^\/+/, '')).join('/'), root);
}

function parseBody(text: string): unknown {
	if (text.length === 0) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

// A contract becomes a tool that calls it through APISIX, naming the owner so that the gateway
// attaches the owner's token: the harness never holds one. What comes back is data for the model.
export function makeContractTool(contract: ContractDefinition, deps: ContractToolDeps): Tool {
	const { config, log } = deps;
	const fetchImpl = deps.fetchImpl ?? fetch;
	const definition: LlmToolDefinition = {
		type: 'function',
		function: {
			name: contract.toolName,
			description: contract.description,
			parameters: toolParametersOf(contract)
		}
	};
	const argumentKeys = [
		...contract.parameters.map((p) => p.name),
		...(contract.bodySchema === null ? [] : ['body'])
	];

	async function audit(context: ToolContext, status: number): Promise<void> {
		try {
			await fetchImpl(joinPath(config.apisix.baseUrl, config.contracts.auditPath), {
				method: 'POST',
				headers: { 'content-type': 'application/json', apikey: config.apisix.consumerKey },
				body: JSON.stringify({
					principal: context.principalId,
					contract: contract.id,
					method: contract.method,
					status,
					at: new Date().toISOString()
				}),
				signal: AbortSignal.timeout(5000)
			});
		} catch (err: unknown) {
			log.warn({ contract: contract.id, err }, 'audit not delivered');
		}
	}

	return {
		definition,
		argumentKeys,
		requiredAction: 'contracts.call',
		run: async (args, context): Promise<ToolOutcome> => {
			const values =
				typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
			let path = contract.pathTemplate;
			const query = new URLSearchParams();
			for (const parameter of contract.parameters) {
				const value = values[parameter.name];
				if (value === undefined || value === null) {
					if (parameter.required) return { result: { error: `${parameter.name} is required` } };
					continue;
				}
				if (parameter.location === 'path') {
					path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
				} else {
					query.set(parameter.name, String(value));
				}
			}
			const url = joinPath(config.apisix.baseUrl, config.contracts.basePath, path);
			url.search = query.toString();
			const headers: Record<string, string> = {
				apikey: config.apisix.consumerKey,
				'x-twake-on-behalf-of': context.principalId,
				'x-twake-contract': contract.id
			};
			const body = contract.bodySchema === null ? undefined : JSON.stringify(values['body'] ?? {});
			if (body !== undefined) headers['content-type'] = 'application/json';
			let status = 0;
			let result: unknown;
			try {
				const response = await fetchImpl(url, {
					method: contract.method.toUpperCase(),
					headers,
					...(body === undefined ? {} : { body }),
					signal: AbortSignal.timeout(config.contracts.timeoutMs)
				});
				status = response.status;
				result = { status, body: parseBody(await response.text()) };
			} catch (err: unknown) {
				result = {
					error: `the contract could not be called: ${err instanceof Error ? err.message : String(err)}`
				};
			}
			log.info(
				{ contract: contract.id, method: contract.method, status, principal: context.principalId },
				'contract called'
			);
			void audit(context, status);
			return { result };
		}
	};
}
