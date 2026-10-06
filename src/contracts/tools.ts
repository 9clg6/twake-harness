import type { FastifyBaseLogger } from 'fastify';

import { fetchOwnerMessages } from '../assistants/locale.js';
import type { Config } from '../config.js';
import { hasConsent, insertPendingCall } from '../consents/repository.js';
import { withPrincipal } from '../db/client.js';
import { ORGANIZATION_PRINCIPAL } from '../principals/principal.js';
import type { LlmToolDefinition } from '../llm/client.js';
import type { Tool, ToolOutcome } from '../agent/tools.js';
import { toolParametersOf, type ContractDefinition } from './openapi.js';

export interface ContractToolDeps {
	readonly config: Config;
	readonly log: FastifyBaseLogger;
	readonly fetchImpl?: typeof fetch;
	// The path of the document's server, from readServer: empty when the paths are absolute
	readonly serverPath?: string;
}

// Joins path segments under the gateway's address, keeping the path that address may carry: no
// segment may climb back to the root, and an empty one adds nothing
export function joinPath(base: URL, ...segments: string[]): URL {
	const root = base.href.endsWith('/') ? base.href : `${base.href}/`;
	const kept = segments
		.map((segment, index) => {
			const trimmed = segment.replace(/^\/+/, '');
			return index === segments.length - 1 ? trimmed : trimmed.replace(/\/+$/, '');
		})
		.filter((segment) => segment.length > 0);
	return new URL(kept.join('/'), root);
}

function parseBody(text: string): unknown {
	if (text.length === 0) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

// Reading a contract and acting through one are separate rights: a turn an event started holds
// the first and never the second
export const CALL_CONTRACTS = 'contracts.call';
export const ACT_THROUGH_CONTRACTS = 'contracts.act';

// The assistant's own feed of workplace events, read without asking: it is how events reach the
// owner in the first place
const FEED_DOMAIN = 'events';

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

	return {
		definition,
		argumentKeys,
		requiredAction: contract.level === 'read' ? CALL_CONTRACTS : ACT_THROUGH_CONTRACTS,
		run: async (args, context): Promise<ToolOutcome> => {
			const values =
				typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
			// The first read of an application waits for its owner: the call is frozen as the model
			// wrote it, and the turn ends with the harness's own question. The organization agent
			// acts for no user, so nobody's consent applies to it.
			const owner = context.principalId;
			if (
				contract.level === 'read' &&
				contract.domain !== FEED_DOMAIN &&
				owner !== ORGANIZATION_PRINCIPAL &&
				!(await withPrincipal(context.db, { id: owner }, (tx) =>
					hasConsent(tx, owner, contract.domain, contract.level)
				))
			) {
				const pendingCallId = await withPrincipal(context.db, { id: owner }, (tx) =>
					insertPendingCall(tx, {
						owner,
						tool: contract.toolName,
						contract: contract.id,
						domain: contract.domain,
						level: contract.level,
						reasons: ['consent'],
						arguments: values,
						correlationId: context.correlationId ?? null,
						origin: context.origin ?? 'owner'
					})
				);
				log.info(
					{
						pendingCallId,
						contract: contract.id,
						tool: contract.toolName,
						domain: contract.domain,
						level: contract.level,
						principal: owner
					},
					'contract call waits for its owner'
				);
				return {
					result: {
						status: 'awaiting_owner',
						reason: 'consent',
						domain: contract.domain,
						level: contract.level
					},
					final: (await fetchOwnerMessages(context.db, owner, config.locale)).consent.firstRead(
						contract.domain
					),
					pendingCallId
				};
			}
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
				} else if (Array.isArray(value)) {
					// One key per item, the OpenAPI default for a query array (form, exploded): a
					// joined "a,b" would reach the contract as a single value
					for (const item of value as readonly unknown[])
						query.append(parameter.name, String(item));
				} else {
					query.set(parameter.name, String(value));
				}
			}
			// The path the document gives, under its server path and the prefix the deployment may
			// add, always on the gateway: the harness has no other way out
			const url = joinPath(
				config.apisix.baseUrl,
				config.contracts.basePath,
				deps.serverPath ?? '',
				path
			);
			url.search = query.toString();
			// The organization agent calls with the harness key alone: it acts for no user
			const headers: Record<string, string> = {
				apikey: config.apisix.consumerKey,
				'x-twake-contract': contract.id
			};
			if (context.principalId !== ORGANIZATION_PRINCIPAL) {
				headers['x-twake-on-behalf-of'] = context.principalId;
			}
			// The gateway writes the audit record of the call; this id links it to the turn
			if (context.correlationId !== undefined && context.correlationId.length > 0) {
				headers['x-correlation-id'] = context.correlationId;
			}
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
			return { result };
		}
	};
}
