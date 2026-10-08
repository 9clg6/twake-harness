import { createHash } from 'node:crypto';

import { wallDayAt, type Clock } from '../agent/clock.js';
import {
	findAssistant,
	isActiveAssistant,
	listActiveAssistants
} from '../assistants/repository.js';
import { withPrincipal } from '../db/client.js';
import { fetchOwnerTimeZone } from '../settings/time-zone.js';
import { BRIEF_EVENT_TYPE } from '../wakeups/event-types.js';
import { BRIEF_SOURCE, wake, type WakeDeps } from '../wakeups/wake.js';

// The hour of the owner's wall clock from which the brief of a working day is due, and how many
// hours a pass still sends it after that
const BRIEF_HOUR = 8;
const BRIEF_WINDOW_HOURS = 3;

// What the wake-ups need, and the present the passes read
export interface BriefDeps extends WakeDeps {
	readonly clock: Clock;
}

// The date of each owner's brief a scheduler is done with, sent, skipped, or not to send: its next
// passes look no further at that owner until their next date
export type SettledBriefs = Map<string, string>;

// Monday to Friday, for a date as dateIn gives it
function isWorkingDay(date: string): boolean {
	const day = new Date(`${date}T00:00:00Z`).getUTCDay();
	return day >= 1 && day <= 5;
}

// The id of an owner's brief of a date: the same on every pass and every replica, and another for
// every other owner, so that their wake-ups, logs and calls through the gateway tell the briefs
// apart without naming whose they are
export function briefId(owner: string, date: string): string {
	const digest = createHash('sha256')
		.update(JSON.stringify([owner, date]))
		.digest('hex');
	return `brief-${date}-${digest.slice(0, 16)}`;
}

// Whether a pass woke the owner for that brief, which the wake-ups keep for two days at least
async function wasWoken(deps: BriefDeps, owner: string, id: string): Promise<boolean> {
	const rows = await deps.db.sql`
		select 1 from wakeups where source = ${BRIEF_SOURCE} and event_id = ${id} and owner = ${owner}`;
	return rows.length > 0;
}

// One owner's brief at this pass, on their wall clock: from eight on a working day, their
// assistant is woken for the brief of that date, which wake() keeps from going twice, as it keeps
// any wake-up, and counts in their hourly wake-ups. One their cap held back is tried again at the
// next pass. Three hours past eight, the day is theirs no more: a brief that never went is skipped,
// which a line says. Their wall clock is read first, as it is all most passes need of them.
async function briefOwner(deps: BriefDeps, owner: string, settled: SettledBriefs): Promise<void> {
	const { config, db, clock, log } = deps;
	const timeZone = await fetchOwnerTimeZone(db, owner, config.timeZone);
	const { date, hour } = wallDayAt(clock.now(), timeZone);
	if (settled.get(owner) === date || !isWorkingDay(date) || hour < BRIEF_HOUR) return;
	const assistant = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
	if (!isActiveAssistant(assistant)) return;
	const id = briefId(owner, date);
	if (hour >= BRIEF_HOUR + BRIEF_WINDOW_HOURS) {
		settled.set(owner, date);
		if (!(await wasWoken(deps, owner, id))) {
			log.info({ owner, date, timeZone, id }, 'morning brief skipped');
		}
		return;
	}
	const outcome = await wake(deps, {
		source: BRIEF_SOURCE,
		id,
		type: BRIEF_EVENT_TYPE,
		recipient: { email: owner, uuid: null, reason: 'owner' },
		actor: { email: null, uuid: null },
		shown: { computed: { type: BRIEF_EVENT_TYPE, source: BRIEF_SOURCE, id }, untrusted: {} },
		brief: { date }
	});
	if (outcome !== 'capped') settled.set(owner, date);
}

// One pass over the owners whose assistant is in its room, one after the other: an owner whose
// brief could not be looked at is skipped with a warning, and the pass goes on with the next one.
// A pass told to stop stops before the next owner.
export async function runBriefPass(
	deps: BriefDeps,
	settled: SettledBriefs = new Map(),
	stopping: () => boolean = () => false
): Promise<void> {
	const owners = [...new Set((await listActiveAssistants(deps.db)).map(({ owner }) => owner))];
	for (const owner of owners.sort((a, b) => a.localeCompare(b))) {
		if (stopping()) break;
		try {
			await briefOwner(deps, owner, settled);
		} catch (err: unknown) {
			deps.log.warn({ owner, err }, 'morning brief failed');
		}
	}
}

export interface BriefScheduler {
	// Stops looking, once the pass under way, if any, is done with its owner of the moment
	stop(): Promise<void>;
}

// Passes at once, then every checkMs, when BRIEF_ENABLED is on: the brief of each owner's working
// day goes out from eight in the zone of their calendar, the deployment's until a read of it named
// one. Kept by owner and date, as any wake-up, a brief goes out once, whether a pass runs again
// after a restart or on another replica.
export function startBriefScheduler(deps: BriefDeps, checkMs: number): BriefScheduler {
	if (!deps.config.brief.enabled) {
		deps.log.info({ setting: 'BRIEF_ENABLED' }, 'morning briefs off');
		return { stop: () => Promise.resolve() };
	}
	const settled: SettledBriefs = new Map();
	let running: Promise<void> | null = null;
	let stopped = false;
	const tick = (): void => {
		if (running !== null || stopped) return;
		running = runBriefPass(deps, settled, () => stopped)
			.catch((err: unknown) => {
				deps.log.error({ err }, 'morning briefs failed');
			})
			.finally(() => {
				running = null;
			});
	};
	tick();
	const timer = setInterval(tick, checkMs);
	return {
		stop: async () => {
			stopped = true;
			clearInterval(timer);
			await running;
		}
	};
}
