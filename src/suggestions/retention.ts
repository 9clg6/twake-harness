import type { FastifyBaseLogger } from 'fastify';

import { withPrincipal, type Db, type Tx } from '../db/client.js';
import { HOUR_MS } from '../wakeups/retention.js';
import { DAY_MS } from './repository.js';

// Forgets, in the transaction given under the owner's principal, the suggestions made them that
// nothing reads any more, and the mutes of theirs that ended. A suggestion stays a day, which the
// caps count, or the lifetime of a request when longer, and as long as its call waits for the
// owner, as a refusal reads it. Resolves to how many rows went.
export async function purgeSuggestionsOf(
	tx: Tx,
	owner: string,
	lifetimeMs: number
): Promise<number> {
	const keptMs = Math.max(DAY_MS, lifetimeMs);
	const suggestions = await tx.sql`
		delete from suggestions s
		where s.owner = ${owner}
			and s.created_at < now() - make_interval(secs => ${keptMs / 1000})
			and not exists (
				select 1 from pending_calls p
				where p.owner = ${owner} and p.id = s.pending_call_id and p.status = 'open')`;
	const mutes = await tx.sql`
		delete from suggestion_mutes where owner = ${owner} and until is not null and until <= now()`;
	return suggestions.count + mutes.count;
}

// A pass of the worker role over every owner, each owner's rows touched under their own principal,
// whether the suggestions are on or not: what they kept from a time they were on goes too. Resolves
// to how many rows went.
export async function purgeSuggestions(
	db: Db,
	log: FastifyBaseLogger,
	lifetimeMs: number
): Promise<number> {
	const owners = (
		await db.sql<{ owner: string }[]>`select owner from principal_index order by owner`
	).map((r) => r.owner);
	let purged = 0;
	for (const owner of owners) {
		try {
			purged += await withPrincipal(db, { id: owner }, (tx) =>
				purgeSuggestionsOf(tx, owner, lifetimeMs)
			);
		} catch (err: unknown) {
			log.error({ owner, err }, 'suggestion purge of an owner failed');
		}
	}
	if (purged > 0) log.info({ purged }, 'suggestions purged');
	return purged;
}

export interface SuggestionPurgeScheduler {
	stop(): void;
}

// A purge at once, then every hour
export function startSuggestionPurgeScheduler(
	db: Db,
	log: FastifyBaseLogger,
	lifetimeMs: number
): SuggestionPurgeScheduler {
	const tick = (): void => {
		void purgeSuggestions(db, log, lifetimeMs).catch((err: unknown) =>
			log.error({ err }, 'suggestion purge failed')
		);
	};
	tick();
	const timer = setInterval(tick, HOUR_MS);
	return {
		stop: () => {
			clearInterval(timer);
		}
	};
}
