import { fetchOwnerMessages } from '../assistants/locale.js';
import type { Tool } from '../agent/tools.js';
import type { Config } from '../config.js';
import type { ConsentLevel } from '../consents/consent.js';
import type { ConsentMetrics } from '../consents/metrics.js';
import { insertPendingCall, type PendingCallInput } from '../consents/repository.js';
import { makeOwnerRequest, type OwnerRequest } from '../consents/request.js';
import { labelOf, type DomainDescriptions } from '../contracts/domains.js';
import { withPrincipal, type Db } from '../db/client.js';
import { getMessages, type Locale } from '../i18n/messages.js';

export const SUGGEST_TOOL = 'suggest_after_consent';

// What the call frozen for a suggestion's first use names in place of a contract, by which the
// call its owner allowed finds its tool again
export const SUGGEST_CALL = 'harness.suggest_after_consent';

export interface SuggestionConsentDeps {
	readonly config: Config;
	readonly db: Db;
	readonly domains: DomainDescriptions;
	readonly consentMetrics: ConsentMetrics;
}

// What a suggestion reads that its owner never allowed, and why it would read it: to propose a
// slot for a message of this other person, whose address the harness computed
export interface LackedConsent {
	readonly owner: string;
	readonly other: string;
	readonly domain: string;
	readonly level: ConsentLevel;
	// The message the suggestion comes from, which links the question to it in the audit
	readonly eventId: string;
	// Whether the suggestion waited for an answer already: it asks only the first time it looks
	readonly waited: boolean;
}

export interface ConsentQuestion {
	readonly pendingCallId: string;
	readonly request: OwnerRequest;
}

// Asks the owner for the permission a suggestion lacks, with the question of a first use, once
// per application and level: none while a request for it waits, the suggestion's or one of their
// own turns, and none after a no to a suggestion. A suggestion asks only the first time it looks:
// once the request it waited for is answered no or replaced by a newer one, it gives up. The call
// it freezes holds nothing of the messages, which stay in the suggestion's job alone. Resolves to
// the question to send, to 'waiting' while a request for that permission waits for its owner, or
// to null when there is nothing to ask nor to wait for.
export async function askSuggestionConsent(
	deps: SuggestionConsentDeps,
	lacked: LackedConsent,
	locale: Locale
): Promise<ConsentQuestion | 'waiting' | null> {
	const { config, db, consentMetrics } = deps;
	const { owner, domain, level } = lacked;
	const messages = getMessages(locale);
	const request = makeOwnerRequest(
		{
			tool: SUGGEST_TOOL,
			application: labelOf(deps.domains, domain, level, locale, config.locale),
			level,
			reasons: ['consent'],
			arguments: {},
			summary: null,
			said: messages.suggestions.consentContext(lacked.other)
		},
		messages
	);
	if (request === null) return null;
	const call: PendingCallInput = {
		owner,
		tool: SUGGEST_TOOL,
		contract: SUGGEST_CALL,
		domain,
		level,
		reasons: ['consent'],
		arguments: {},
		previewDigest: null,
		correlationId: `suggest-${lacked.eventId}`,
		origin: 'suggestion',
		sessionId: null,
		request: request.question
	};
	const asked = await withPrincipal(db, { id: owner }, async (tx) => {
		// A request for that permission that waits is waited for, and a suggestion's question the
		// owner refused is not asked again; one that expired or that a newer request superseded is,
		// by a later suggestion. A column of reasons is kept as the JSON text of its list.
		const before = await tx.sql<{ status: string }[]>`
			select status from pending_calls
			where owner = ${owner} and domain = ${domain} and level = ${level}
				and ((status = 'open' and (reasons #>> '{}')::jsonb @> '["consent"]'::jsonb)
					or (contract = ${SUGGEST_CALL} and status = 'refused'))
			order by status = 'open' desc
			limit 1`;
		const status = before[0]?.status;
		if (status === 'open') return 'waiting';
		return status === undefined && !lacked.waited ? insertPendingCall(tx, call) : null;
	});
	if (asked === null || asked === 'waiting') return asked;
	consentMetrics.requested(call);
	return { pendingCallId: asked, request };
}

// What the owner's yes to such a question runs, once it let their assistant read what the
// suggestion needs: the words that end their turn. The suggestion that waited goes on by itself.
// It is no tool of the model's nor of the API's, which never find it: the replay of the call
// frozen as SUGGEST_CALL alone runs it.
export function makeSuggestionConsentTool(deps: { readonly config: Config }): Tool {
	return {
		definition: {
			type: 'function',
			function: {
				name: SUGGEST_TOOL,
				description: 'Lets the suggestion that waited for its owner go on.',
				parameters: { type: 'object', properties: {}, additionalProperties: false }
			}
		},
		argumentKeys: [],
		requiredAction: null,
		frozenAs: SUGGEST_CALL,
		run: async (_args, context) => {
			const { suggestions } = await fetchOwnerMessages(
				context.db,
				context.principalId,
				deps.config.locale
			);
			return { result: { success: true }, final: suggestions.consentGranted };
		}
	};
}
