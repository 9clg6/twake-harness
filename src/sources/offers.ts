import type { FastifyBaseLogger } from 'fastify';

import { localeOf } from '../assistants/locale.js';
import { findAssistant } from '../assistants/repository.js';
import type { Config } from '../config.js';
import type { ResumeRequest } from '../consents/consent.js';
import {
	approvePendingCall,
	findPendingCall,
	grantConsent,
	markReplayed
} from '../consents/repository.js';
import { labelOf, type DomainDescriptions } from '../contracts/domains.js';
import { withPrincipal, type Db, type Tx } from '../db/client.js';
import { getMessages } from '../i18n/messages.js';
import type { Principal } from '../principals/principal.js';
import { findChoices, saveListening } from './repository.js';
import {
	isListenable,
	listeningSaid,
	readDomainOf,
	type Source,
	type SourceEntry,
	type SourceRegistry
} from './sources.js';

// What a source offer goes under among the calls that wait for their owner's answer: its tool and
// its contract, which no application has. Its domain is the source it offers, which its arguments
// name too.
export const SOURCE_OFFER = 'source_offer';

// A source of the registry that has a source offer
export type OfferedEntry = SourceEntry & Required<Pick<SourceEntry, 'offer'>>;

// The source a brief offers its owner after it, if any: the first of the registry with a source
// offer that their assistant may listen to and does not by default, that they never chose for, and
// that no brief offered them before
export async function nextOffer(
	tx: Tx,
	owner: string,
	registry: SourceRegistry
): Promise<OfferedEntry | null> {
	const choices = await findChoices(tx, owner);
	const rows = await tx.sql<{ source: string }[]>`
		select source from source_offers where owner = ${owner}`;
	const offered = rows.map(({ source }) => source);
	const entry = registry.find(
		(candidate): candidate is OfferedEntry =>
			candidate.offer !== undefined &&
			candidate.listenable &&
			!candidate.byDefault &&
			choices[candidate.source] === 'none' &&
			!offered.includes(candidate.source)
	);
	return entry ?? null;
}

// The brief that makes a source offer goes out: no brief offers that source again, whatever becomes
// of the source offer
export async function noteOffer(tx: Tx, owner: string, source: Source): Promise<void> {
	await tx.sql`
		insert into source_offers (owner, source) values (${owner}, ${source})
		on conflict (owner, source) do nothing`;
}

// The source a source offer's call offers, or null for any other call
function offeredSource(call: { readonly tool: string; readonly domain: string }): Source | null {
	return call.tool === SOURCE_OFFER && isListenable(call.domain) ? call.domain : null;
}

// The owner said no to a source offer a brief made them: they chose for their assistant not to
// listen there. Any other call changes nothing.
export async function refuseSourceOffer(
	tx: Tx,
	owner: string,
	pendingCallId: string
): Promise<void> {
	const call = await findPendingCall(tx, owner, pendingCallId);
	const source = call === null ? null : offeredSource(call);
	if (source !== null) await saveListening(tx, owner, source, false);
}

export interface SourceOfferDeps {
	readonly config: Config;
	readonly db: Db;
	// How the catalog names the applications to their owners, as it last loaded
	readonly domains: () => DomainDescriptions;
}

// The owner's yes to a source offer a brief made them
export interface OfferAnswer {
	readonly principal: Principal;
	readonly pendingCallId: string;
	// Where they said yes, which the read it allows records
	readonly through: ResumeRequest['through'];
	readonly log: FastifyBaseLogger;
}

export type OfferAccepted =
	// Their assistant listens there, as the harness's own words tell them
	| { readonly kind: 'ok'; readonly text: string }
	// The source offer no longer waited, or the source can no longer be listened to
	| { readonly kind: 'missing' };

// The owner's yes to a source offer a brief made them has their assistant listen there, and lets it
// read the application listening reads, at the read level, as their yes to listening does, in the
// transaction that settles the call. The harness says so in its own words, as listening does: no
// model call, no admission and no gate.
export async function acceptSourceOffer(
	deps: SourceOfferDeps,
	input: OfferAnswer
): Promise<OfferAccepted> {
	const { config, db } = deps;
	const { principal, pendingCallId } = input;
	const accepted = await withPrincipal(db, principal, async (tx) => {
		const approved = await approvePendingCall(tx, principal.id, pendingCallId);
		if (approved === null) return null;
		// Only a source offer's call comes here, which the turn worker tells by its tool
		if (approved.tool !== SOURCE_OFFER) throw new Error('the call is no source offer');
		await markReplayed(tx, pendingCallId);
		const source = approved.domain;
		if (!isListenable(source)) return null;
		const reads = readDomainOf(source);
		if (reads !== null) await grantConsent(tx, principal.id, reads, 'read', input.through);
		await saveListening(tx, principal.id, source, true);
		return { source, locale: localeOf(await findAssistant(tx, principal.id), config.locale) };
	});
	if (accepted === null) return { kind: 'missing' };
	const { source, locale } = accepted;
	input.log.info({ pendingCallId, source, listening: true }, 'listened source set');
	const { name } = labelOf(deps.domains(), source, 'read', locale, config.locale);
	return { kind: 'ok', text: listeningSaid(getMessages(locale), source, name, true) };
}
