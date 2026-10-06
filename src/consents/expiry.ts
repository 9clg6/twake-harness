import type { FastifyBaseLogger } from 'fastify';

import { withPrincipal, type Db } from '../db/client.js';
import { expireRequests } from './repository.js';

// How often the worker role looks for requests left unanswered past their lifetime
const EXPIRY_INTERVAL_MS = 3_600_000;

// The requests nobody answered within their lifetime expire, and what their calls would have sent
// is erased, so that an owner's data does not pile up: a pass of the worker role over every owner,
// each owner's rows touched under their own principal. Resolves to how many expired.
export async function expireOverdueRequests(
	db: Db,
	log: FastifyBaseLogger,
	lifetimeMs: number
): Promise<number> {
	const owners = (
		await db.sql<{ owner: string }[]>`select owner from principal_index order by owner`
	).map((r) => r.owner);
	let expired = 0;
	for (const owner of owners) {
		try {
			const ids = await withPrincipal(db, { id: owner }, (tx) =>
				expireRequests(tx, owner, lifetimeMs)
			);
			for (const id of ids) log.info({ owner, pendingCallId: id }, 'request expired');
			expired += ids.length;
		} catch (err: unknown) {
			log.error({ owner, err }, 'request expiry of an owner failed');
		}
	}
	return expired;
}

export interface ExpiryScheduler {
	stop(): void;
}

export function startExpiryScheduler(
	db: Db,
	log: FastifyBaseLogger,
	lifetimeMs: number
): ExpiryScheduler {
	const tick = (): void => {
		void expireOverdueRequests(db, log, lifetimeMs).catch((err: unknown) =>
			log.error({ err }, 'request expiry failed')
		);
	};
	tick();
	const timer = setInterval(tick, EXPIRY_INTERVAL_MS);
	return {
		stop: () => {
			clearInterval(timer);
		}
	};
}
