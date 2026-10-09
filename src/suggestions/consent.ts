import { fetchOwnerMessages } from '../assistants/locale.js';
import type { Tool } from '../agent/tools.js';
import type { Config } from '../config.js';
import type { ConsentMetrics } from '../consents/metrics.js';
import { insertPendingCall, type PendingCallInput } from '../consents/repository.js';
import { makeOwnerRequest, type OwnerRequest } from '../consents/request.js';
import { labelOf, type DomainDescriptions } from '../contracts/domains.js';
import { withPrincipal, type Db } from '../db/client.js';
import { getMessages, type Locale } from '../i18n/messages.js';
import { enqueueJob } from '../jobs/queue.js';
import {
	SUGGEST_MAX_AGE_MS,
	suggestGroup,
	suggestPayloadSchema,
	type SuggestPayload
} from './job.js';

export const SUGGEST_TOOL = 'suggest_after_consent';

// What the call frozen for a suggestion's first use names in place of a contract, by which the
// call its owner allowed finds its tool again
export const SUGGEST_CALL = 'harness.suggest_after_consent';

export interface ConsentQuestion {
	readonly pendingCallId: string;
	readonly request: OwnerRequest;
}

// Asks the owner for the permission a suggestion lacks, with the question of a first use, once
// per application and level: none while one waits, and none after a no. The call it freezes holds
// the job's payload, quotes included, until the owner answers: a no or an expiry erases them, and
// the yes queues the job again, should it be young enough. Resolves to the question to send, or to
// null when nothing is to be asked.
export async function askSuggestionConsent(
	deps: {
		readonly config: Config;
		readonly db: Db;
		readonly domains: DomainDescriptions;
		readonly consentMetrics: ConsentMetrics;
	},
	payload: SuggestPayload,
	locale: Locale,
	contract: { readonly domain: string; readonly level: 'read' | 'write' }
): Promise<ConsentQuestion | null> {
	const { config, db, consentMetrics } = deps;
	const owner = payload.owner;
	const author = payload.quoted.at(-1)?.email ?? payload.retry?.attendees[0];
	if (author === undefined) return null;
	const messages = getMessages(locale);
	const request = makeOwnerRequest(
		{
			tool: SUGGEST_TOOL,
			application: labelOf(deps.domains, contract.domain, contract.level, locale, config.locale),
			level: contract.level,
			reasons: ['consent'],
			arguments: {},
			summary: null,
			said: messages.suggestions.consentContext(author)
		},
		messages
	);
	if (request === null) return null;
	const call: PendingCallInput = {
		owner,
		tool: SUGGEST_TOOL,
		contract: SUGGEST_CALL,
		domain: contract.domain,
		level: contract.level,
		reasons: ['consent'],
		arguments: { payload },
		previewDigest: null,
		correlationId: `suggest-${payload.eventId}`,
		origin: 'suggestion',
		sessionId: null,
		request: request.question
	};
	const pendingCallId = await withPrincipal(db, { id: owner }, async (tx) => {
		// A question that waits, or that the owner refused, is not asked again; one that expired or
		// that a newer request superseded is
		const asked = await tx.sql`
			select 1 from pending_calls
			where owner = ${owner} and contract = ${SUGGEST_CALL} and domain = ${contract.domain}
				and level = ${contract.level} and status in ('open', 'refused')
			limit 1`;
		return asked.count > 0 ? null : insertPendingCall(tx, call);
	});
	if (pendingCallId === null) return null;
	consentMetrics.requested(call);
	return { pendingCallId, request };
}

// The tool by which the owner's yes to such a question queues the suggestion again, if it is still
// young: otherwise the next message suggests. It is no tool for the model, which is never offered
// it, and its call shows nothing of the quotes in the conversation (see replay).
export function makeSuggestionResumeTool(deps: { readonly config: Config }): Tool {
	return {
		definition: {
			type: 'function',
			function: {
				name: SUGGEST_TOOL,
				description: 'Queues again the suggestion that waited for its owner.',
				parameters: { type: 'object', properties: {}, additionalProperties: false }
			}
		},
		hidden: true,
		argumentKeys: ['payload'],
		requiredAction: null,
		frozenAs: SUGGEST_CALL,
		run: async (args, context) => {
			const parsed = suggestPayloadSchema.safeParse(
				typeof args === 'object' && args !== null ? Reflect.get(args, 'payload') : undefined
			);
			const { suggestions } = await fetchOwnerMessages(
				context.db,
				context.principalId,
				deps.config.locale
			);
			const final = suggestions.consentGranted;
			if (!parsed.success || Date.now() - parsed.data.at > SUGGEST_MAX_AGE_MS) {
				context.log.info('suggestion not queued again: too old');
				return { result: { status: 'expired' }, final };
			}
			const { owner } = parsed.data;
			await enqueueJob(context.db, {
				kind: 'suggest',
				payload: parsed.data,
				dedupKey: `suggest:${parsed.data.eventId}:${owner}:allowed`,
				groupKey: suggestGroup(owner)
			});
			return { result: { status: 'queued' }, final };
		}
	};
}
