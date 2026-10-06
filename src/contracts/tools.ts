import type { FastifyBaseLogger } from 'fastify';

import { fetchOwnerLocale } from '../assistants/locale.js';
import type { Config } from '../config.js';
import { isBuiltInConsent, type WaitReason } from '../consents/consent.js';
import { readDelegationCode, type DelegationCode } from '../consents/delegation.js';
import type { ConsentMetrics } from '../consents/metrics.js';
import { hasConsent, insertPendingCall, type PendingCallInput } from '../consents/repository.js';
import { makeOwnerRequest, requestText } from '../consents/request.js';
import { withPrincipal } from '../db/client.js';
import { getMessages } from '../i18n/messages.js';
import { ORGANIZATION_PRINCIPAL } from '../principals/principal.js';
import type { LlmToolDefinition } from '../llm/client.js';
import type { Tool, ToolContext, ToolOutcome } from '../agent/tools.js';
import { labelOf, type DomainDescriptions } from './domains.js';
import { toolParametersOf, type ContractDefinition } from './openapi.js';

export interface ContractToolDeps {
	readonly config: Config;
	readonly log: FastifyBaseLogger;
	readonly fetchImpl?: typeof fetch;
	// The path of the document's server, from readServer: empty when the paths are absolute
	readonly serverPath?: string;
	// Where the api role counts the calls that wait for their owner
	readonly consentMetrics: ConsentMetrics;
	// How the document names the applications to their owners, from readDomains
	readonly domains: DomainDescriptions;
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

// Reading a contract and acting through one are separate rights, which stay a switch above what
// an owner allows: a principal without the second never writes, whoever asks
export const CALL_CONTRACTS = 'contracts.call';
export const ACT_THROUGH_CONTRACTS = 'contracts.act';

// What the model reads when a call that would wait for its owner is too large to show them whole:
// nothing waits, and it may make the call smaller
const TOO_LARGE_TO_CONFIRM = {
	error: 'too_large_to_confirm',
	hint: 'The owner must see a call whole before it runs, and this one is too large to show in one message. Nothing was done. Make the call smaller, for instance with a shorter text, then make it again.'
} as const;

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

	// Freezes the call as the model wrote it until its owner answers, counts it, and logs why it
	// waits, never what it would send; resolves to the frozen call's id
	async function freeze(
		values: Record<string, unknown>,
		context: ToolContext,
		reasons: readonly WaitReason[]
	): Promise<string> {
		const owner = context.principalId;
		const call: PendingCallInput = {
			owner,
			tool: contract.toolName,
			contract: contract.id,
			domain: contract.domain,
			level: contract.level,
			reasons,
			arguments: values,
			correlationId: context.correlationId ?? null,
			origin: context.origin ?? 'owner'
		};
		const pendingCallId = await withPrincipal(context.db, { id: owner }, (tx) =>
			insertPendingCall(tx, call)
		);
		deps.consentMetrics.requested(call);
		log.info(
			{
				pendingCallId,
				reasons,
				contract: contract.id,
				tool: contract.toolName,
				domain: contract.domain,
				level: contract.level,
				...(contract.risk === null ? {} : { risk: contract.risk }),
				principal: owner
			},
			'contract call waits for its owner'
		);
		return pendingCallId;
	}

	// Why a call waits for its owner, every reason that applies: the first read of an application,
	// or the first write there even once it may read; a write that a turn an event started
	// prepared, each time, since what arrived was written by someone else; and a high-risk write,
	// each time, whatever its owner allowed. The organization agent acts for no user: none of its
	// calls waits for anyone.
	async function reasonsToWait(context: ToolContext): Promise<WaitReason[]> {
		const owner = context.principalId;
		if (owner === ORGANIZATION_PRINCIPAL) return [];
		const reasons: WaitReason[] = [];
		if (
			!isBuiltInConsent(contract.domain, contract.level) &&
			!(await withPrincipal(context.db, { id: owner }, (tx) =>
				hasConsent(tx, owner, contract.domain, contract.level)
			))
		) {
			reasons.push('consent');
		}
		if (contract.level === 'write' && context.origin === 'event') reasons.push('event_turn');
		if (contract.risk === 'high') reasons.push('high_risk');
		return reasons;
	}

	return {
		definition,
		argumentKeys,
		requiredAction: contract.level === 'read' ? CALL_CONTRACTS : ACT_THROUGH_CONTRACTS,
		run: async (args, context): Promise<ToolOutcome> => {
			const values =
				typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
			// A call that waits is frozen as the model wrote it, and the turn ends with the harness's
			// own request. The call its owner allowed runs as it was frozen, unless something their
			// yes did not answer applies now, such as writing they took back since: it then waits
			// again, and the request asks about everything that applies.
			const owner = context.principalId;
			const reasons = await reasonsToWait(context);
			const answeredReasons = context.answeredReasons ?? [];
			if (reasons.some((reason) => !answeredReasons.includes(reason))) {
				// The question names the application as the catalog does in its owner's language,
				// and says what the level covers there
				const locale = await fetchOwnerLocale(context.db, owner, config.locale);
				const application = labelOf(
					deps.domains,
					contract.domain,
					contract.level,
					locale,
					config.locale
				);
				const request = makeOwnerRequest(
					{
						application,
						level: contract.level,
						reasons,
						arguments: values,
						said: context.accompanyingText ?? null
					},
					getMessages(locale)
				);
				// A call its owner could not see whole is never asked about: nothing waits, and the
				// model may make it smaller
				if (request === null) {
					log.info(
						{ reasons, contract: contract.id, tool: contract.toolName, principal: owner },
						'contract call too large to ask about'
					);
					return { result: TOO_LARGE_TO_CONFIRM };
				}
				const pendingCallId = await freeze(values, context, reasons);
				return {
					result: {
						status: 'awaiting_owner',
						reasons,
						domain: contract.domain,
						level: contract.level
					},
					final: requestText(request),
					pendingCallId,
					request
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
			let delegation: DelegationCode | null = null;
			try {
				const response = await fetchImpl(url, {
					method: contract.method.toUpperCase(),
					headers,
					...(body === undefined ? {} : { body }),
					signal: AbortSignal.timeout(config.contracts.timeoutMs)
				});
				status = response.status;
				const answered = parseBody(await response.text());
				result = { status, body: answered };
				delegation = readDelegationCode(status, answered);
			} catch (err: unknown) {
				result = {
					error: `the contract could not be called: ${err instanceof Error ? err.message : String(err)}`
				};
			}
			log.info(
				{
					contract: contract.id,
					method: contract.method,
					status,
					principal: context.principalId,
					...(delegation === null ? {} : { delegation })
				},
				'contract called'
			);
			// The platform's broker lacks the owner's permission for their assistant to act for them:
			// the call waits for them, and the turn ends with the harness's own request, which names
			// the application as a first use does, tells them why and gives them the deployment's
			// consent link, never one from the answer, which a contract could have written. The
			// organization agent acts for no user: nobody could give it that permission.
			if (delegation !== null && owner !== ORGANIZATION_PRINCIPAL) {
				const pendingCallId = await freeze(values, context, ['delegation']);
				const locale = await fetchOwnerLocale(context.db, owner, config.locale);
				const application = labelOf(
					deps.domains,
					contract.domain,
					contract.level,
					locale,
					config.locale
				);
				return {
					result: { status: 'awaiting_owner', reason: 'delegation', code: delegation },
					final: getMessages(locale).consent.delegation(
						application.name,
						contract.level,
						delegation,
						config.consent.brokerConsentUrl
					),
					pendingCallId
				};
			}
			return { result };
		}
	};
}
