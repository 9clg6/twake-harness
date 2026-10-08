import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '../config.js';
import { withPrincipal, type Db } from '../db/client.js';
import { dateIn, type Clock } from './clock.js';

export type RefusalReason = 'user_queue_full' | 'user_rate' | 'user_budget' | 'global_rate';

export type AdmissionDecision =
	{ readonly ok: true; release(): void } | { readonly ok: false; readonly reason: RefusalReason };

export interface AdmissionSnapshot {
	readonly inflight: number;
	readonly queued: number;
	readonly refused: Readonly<Record<RefusalReason, number>>;
}

export interface Admission {
	admit(principalId: string): Promise<AdmissionDecision>;
	recordUsage(principalId: string, tokens: number): Promise<void>;
	snapshot(): AdmissionSnapshot;
}

interface Waiter {
	readonly principalId: string;
	resolve(): void;
}

export interface AdmissionDeps {
	readonly config: Config;
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	readonly clock: Clock;
}

// Admission runs before any model call. Limits are per user, so one user cannot saturate the
// replica for the others, and the queue of a full replica is served one user at a time rather
// than first come first served. The turns per minute and the daily tokens are counted in the
// database, so they hold across replicas; the turns in flight and the queue are this replica's.
export function makeAdmission(deps: AdmissionDeps): Admission {
	const { config, db, log, clock } = deps;
	const limits = config.admission;
	let inflight = 0;
	const running = new Map<string, number>();
	const waiting = new Map<string, number>();
	const queue: Waiter[] = [];
	const refused: Record<RefusalReason, number> = {
		user_queue_full: 0,
		user_rate: 0,
		user_budget: 0,
		global_rate: 0
	};

	// The day a user's tokens count in, which starts at midnight in the IANA time zone the assistants
	// read the present in
	function today(): string {
		return dateIn(clock.now(), config.timeZone);
	}

	async function tokensToday(principalId: string): Promise<number> {
		const rows = await withPrincipal(
			db,
			{ id: principalId },
			(tx) => tx.sql<{ tokens: string }[]>`
				select tokens from usage_daily where owner = ${principalId} and day = ${today()}`
		);
		return Number(rows[0]?.tokens ?? 0);
	}

	async function userTurnsLastMinute(principalId: string): Promise<number> {
		return withPrincipal(db, { id: principalId }, async (tx) => {
			await tx.sql`delete from usage_window where owner = ${principalId} and at < now() - interval '60 seconds'`;
			const rows = await tx.sql<{ n: string }[]>`
				select coalesce(sum(turns), 0) as n from usage_window where owner = ${principalId}`;
			return Number(rows[0]?.n ?? 0);
		});
	}

	async function globalTurnsLastMinute(): Promise<number> {
		await db.sql`delete from usage_window_global where at < now() - interval '60 seconds'`;
		const rows = await db.sql<{ n: string }[]>`
			select coalesce(sum(turns), 0) as n from usage_window_global`;
		return Number(rows[0]?.n ?? 0);
	}

	async function recordStart(principalId: string): Promise<void> {
		await withPrincipal(
			db,
			{ id: principalId },
			(tx) => tx.sql`
				insert into usage_window (owner, at, turns) values (${principalId}, date_trunc('second', now()), 1)
				on conflict (owner, at) do update set turns = usage_window.turns + 1`
		);
		await db.sql`
			insert into usage_window_global (at, turns) values (date_trunc('second', now()), 1)
			on conflict (at) do update set turns = usage_window_global.turns + 1`;
	}

	function refuse(principalId: string, reason: RefusalReason): AdmissionDecision {
		refused[reason] += 1;
		log.info(
			{ principal: principalId, reason, inflight, queued: queue.length },
			'admission refused'
		);
		return { ok: false, reason };
	}

	// The next waiter whose user has nothing running goes first; a user with a running turn
	// waits for everyone else before taking a second slot
	function nextWaiter(): Waiter | null {
		const index = queue.findIndex((w) => (running.get(w.principalId) ?? 0) === 0);
		const chosen = index === -1 ? queue.shift() : queue.splice(index, 1)[0];
		return chosen ?? null;
	}

	function start(principalId: string): void {
		inflight += 1;
		running.set(principalId, (running.get(principalId) ?? 0) + 1);
	}

	function release(principalId: string): void {
		inflight -= 1;
		const count = (running.get(principalId) ?? 1) - 1;
		if (count <= 0) running.delete(principalId);
		else running.set(principalId, count);
		const next = nextWaiter();
		if (next !== null) next.resolve();
	}

	return {
		async admit(principalId) {
			if ((await userTurnsLastMinute(principalId)) >= limits.userPerMinute) {
				return refuse(principalId, 'user_rate');
			}
			if ((await globalTurnsLastMinute()) >= limits.globalPerMinute) {
				return refuse(principalId, 'global_rate');
			}
			if ((await tokensToday(principalId)) >= limits.userDailyTokens) {
				return refuse(principalId, 'user_budget');
			}
			const busy = (running.get(principalId) ?? 0) + (waiting.get(principalId) ?? 0);
			if (busy > limits.userQueue) return refuse(principalId, 'user_queue_full');
			if (inflight >= limits.maxInflight || (running.get(principalId) ?? 0) > 0) {
				waiting.set(principalId, (waiting.get(principalId) ?? 0) + 1);
				log.info(
					{ principal: principalId, inflight, queued: queue.length + 1 },
					'admission queued'
				);
				await new Promise<void>((resolve) => queue.push({ principalId, resolve }));
				waiting.set(principalId, (waiting.get(principalId) ?? 1) - 1);
			}
			start(principalId);
			await recordStart(principalId);
			log.info({ principal: principalId, inflight, queued: queue.length }, 'admission granted');
			let released = false;
			return {
				ok: true,
				release: () => {
					if (released) return;
					released = true;
					release(principalId);
				}
			};
		},
		async recordUsage(principalId, tokens) {
			if (tokens <= 0) return;
			await withPrincipal(
				db,
				{ id: principalId },
				(tx) => tx.sql`
					insert into usage_daily (owner, day, tokens) values (${principalId}, ${today()}, ${tokens})
					on conflict (owner, day) do update set tokens = usage_daily.tokens + excluded.tokens`
			);
		},
		snapshot: () => ({ inflight, queued: queue.length, refused: { ...refused } })
	};
}
