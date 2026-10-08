import { daysFrom, describeMoment, wallDayAt, type Clock } from '../agent/clock.js';
import { localeOf } from '../assistants/locale.js';
import {
	findAssistant,
	listActiveAssistants,
	type AssistantRecord
} from '../assistants/repository.js';
import { makeOwnerConsentLink } from '../contracts/consent-link.js';
import { withPrincipal } from '../db/client.js';
import { getMessages } from '../i18n/messages.js';
import { enqueueJob } from '../jobs/queue.js';
import type { WakeDeps } from '../wakeups/wake.js';
import { DelegationRouteMissingError, fetchDelegation, type Delegation } from './broker.js';

// How many days of the calendar before a permission expires its owner is reminded of it
const REMINDER_DAYS = 5;

// What the wake-ups need, and the present the reminders read
export interface ReminderDeps extends WakeDeps {
	readonly clock: Clock;
}

type ActiveAssistant = AssistantRecord & { readonly roomId: string };

// An assistant its owner has not removed, in its room
function isActive(assistant: AssistantRecord | null): assistant is ActiveAssistant {
	return assistant !== null && assistant.deletedAt === null && assistant.roomId !== null;
}

// Whether a permission is due its reminder now: it has not expired, and it expires five days of
// the calendar after today at most, both days as the wall clock of the zone reads them
function isDue(delegation: Delegation, now: Date, timeZone: string): boolean {
	if (delegation.expiresAt.getTime() <= now.getTime()) return false;
	const today = wallDayAt(now, timeZone).date;
	return daysFrom(today, wallDayAt(delegation.expiresAt, timeZone).date) <= REMINDER_DAYS;
}

// Reminds one owner, when their permission is due its reminder and they were never reminded of
// the one they gave on that date, with the deployment's consent link bound to them: the reminder
// is kept with the message it queues, or not at all, in place of the one of the permission they
// gave before, an owner having one kept at most. Resolves to whether it queued one.
async function remindOwner(deps: ReminderDeps, link: string, owner: string): Promise<boolean> {
	const { config, db, clock } = deps;
	const assistant = await withPrincipal(db, { id: owner }, (tx) => findAssistant(tx, owner));
	if (!isActive(assistant)) return false;
	const delegation = await fetchDelegation(config, owner);
	if (delegation === null || !isDue(delegation, clock.now(), config.timeZone)) return false;
	const queued = await withPrincipal(db, { id: owner }, async (tx) => {
		// Read again: the owner may have removed their assistant while the broker answered
		const current = await findAssistant(tx, owner);
		if (!isActive(current)) return false;
		const kept = await tx.sql`
			insert into delegation_reminders (owner, consented_at)
			values (${owner}, ${delegation.consentedAt})
			on conflict do nothing`;
		if (kept.count === 0) return false;
		await tx.sql`
			delete from delegation_reminders
			where owner = ${owner} and consented_at <> ${delegation.consentedAt}`;
		const locale = localeOf(current, config.locale);
		const expiry = describeMoment(delegation.expiresAt, config.timeZone, locale);
		await enqueueJob(tx, {
			kind: 'send',
			payload: {
				asUserId: current.userId,
				roomId: current.roomId,
				text: getMessages(locale).notices.delegationExpiring(
					expiry.date,
					expiry.time,
					makeOwnerConsentLink(link, owner)
				)
			},
			dedupKey: `delegation-reminder:${JSON.stringify([owner, delegation.consentedAt.toISOString()])}`,
			groupKey: `send:${current.roomId}`
		});
		return true;
	});
	if (queued) deps.log.info({ owner }, 'delegation reminder queued');
	return queued;
}

// The day's pass: each owner whose assistant is in its room, one after the other, is reminded in
// that room when the broker says their permission for their assistant to act for them expires
// within five days. An owner the broker could not be asked about is skipped with a warning, which
// names the path the gateway publishes no route at when that is why, and the pass goes on with
// the next one. A pass told to stop stops before the next owner.
async function remindExpiringDelegations(
	deps: ReminderDeps,
	link: string,
	stopping: () => boolean
): Promise<void> {
	const owners = [...new Set((await listActiveAssistants(deps.db)).map(({ owner }) => owner))].sort(
		(a, b) => a.localeCompare(b)
	);
	let reminded = 0;
	for (const owner of owners) {
		if (stopping()) break;
		try {
			if (await remindOwner(deps, link, owner)) reminded += 1;
		} catch (err: unknown) {
			if (err instanceof DelegationRouteMissingError) {
				deps.log.warn({ owner, path: err.path }, 'delegation route missing');
			} else {
				deps.log.warn({ owner, err }, 'delegation reminder skipped');
			}
		}
	}
	deps.log.info({ owners: owners.length, reminded }, 'delegation reminders passed');
}

export interface ReminderScheduler {
	// Stops looking, once the pass under way, if any, is done with its owner of the moment
	stop(): Promise<void>;
}

// Looks at once whether the day's pass is due, then every checkMs. It is due once a day, during the
// reminders' hour on the wall clock of the assistants' zone, and then only: a pass that failed
// runs again at the next look within that hour, and a role started after it, or a pass that failed
// throughout it, waits for the next day's, which misses nobody, a permission being reminded of
// from five days before it expires. Kept by owner and by date of consent, a reminder goes out
// once, whether a pass runs again after a restart or on another replica. Without the deployment's
// consent link, which tells an owner where to renew, nobody is reminded, as the role says once at
// its start.
export function startReminderScheduler(deps: ReminderDeps, checkMs: number): ReminderScheduler {
	const link = deps.config.consent.brokerConsentUrl;
	if (link === null) {
		deps.log.warn({ missing: 'BROKER_CONSENT_URL' }, 'delegation reminders off');
		return { stop: () => Promise.resolve() };
	}
	let doneOn: string | null = null;
	let running: Promise<void> | null = null;
	let stopped = false;
	const pass = async (date: string): Promise<void> => {
		try {
			await remindExpiringDelegations(deps, link, () => stopped);
			doneOn = date;
		} catch (err: unknown) {
			deps.log.error({ err }, 'delegation reminders failed');
		} finally {
			running = null;
		}
	};
	const tick = (): void => {
		if (running !== null || stopped) return;
		const today = wallDayAt(deps.clock.now(), deps.config.timeZone);
		if (today.date === doneOn || today.hour !== deps.config.consent.delegationReminderHour) return;
		running = pass(today.date);
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
