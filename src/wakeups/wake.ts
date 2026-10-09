import type { FastifyBaseLogger } from 'fastify';

import type { Clock } from '../agent/clock.js';
import { carriesInvitation, type Invitation } from '../agent/invitation.js';
import type { TurnPayload } from '../agent/turn-worker.js';
import { localeOf } from '../assistants/locale.js';
import { findAssistant } from '../assistants/repository.js';
import type { Config } from '../config.js';
import { withPrincipal, type Db } from '../db/client.js';
import { getMessages, type Messages } from '../i18n/messages.js';
import { enqueueJob } from '../jobs/queue.js';
import {
	noteActivity,
	NOTHING_SHOWN,
	wasNoted,
	type ActivityOutcome,
	type Noted,
	type Shown
} from '../journal/repository.js';
import { fenced } from '../llm/data.js';
import { matrixLocalpartOfPrincipal } from '../principals/identity.js';
import { isListening } from '../sources/repository.js';
import { sourceOfActivity } from '../sources/sources.js';
import { MOVED_EVENT_TYPE, TASK_ASSIGNED_EVENT_TYPE } from './event-types.js';

// Someone an event names, as its source knows them
export interface Person {
	readonly email: string | null;
	readonly uuid: string | null;
}

// What wakes an assistant: an event a source published, for one of the people it concerns, and
// what its turn shows the model of it, the text other people wrote apart from what the source
// computed
export interface Wakeup {
	readonly source: string;
	readonly id: string;
	readonly type: string;
	readonly recipient: Person & { readonly reason: string };
	readonly actor: Person;
	readonly shown: Shown;
	// What its owner's listening journal keeps of it beyond its source, type and id, nothing unless
	// its source says
	readonly noted?: Noted;
	// For an invitation, or a change to a meeting, what its turn checks before the model speaks
	readonly invitation?: Invitation;
	// For an activity that calls for no word at once: its owner's journal keeps it for their brief,
	// and it wakes nobody
	readonly forBrief?: true;
	// For the brief of its owner's working day, the date in their zone it is the brief of: only the
	// worker role's scheduler sets it, and a turn is a brief's for that alone, never for its type
	readonly brief?: { readonly date: string };
}

// The source of the wake-ups the worker role's scheduler makes, the briefs, which no other wake-up
// may take: a source may publish any name, this one included
export const BRIEF_SOURCE = 'schedule';

export type WakeOutcome =
	'woken' | 'duplicate' | 'no_assistant' | 'ignored' | 'capped' | 'for_brief' | 'unlistened';

export interface WakeDeps {
	readonly config: Config;
	readonly db: Db;
	readonly log: FastifyBaseLogger;
	// The present the daily reminders, the briefs and the listening journal read
	readonly clock: Clock;
}

export interface WakeOptions {
	// Whether a wake-up the owner's hourly cap holds back is logged: the scheduler tries a brief
	// again at each pass, and says so at the first alone
	readonly logCapped?: boolean;
}

// The event as the model is handed it: what its source computed, apart from what people wrote
function eventData(wakeup: Wakeup): string {
	return fenced('event-data', { ...wakeup.shown.computed, untrusted: wakeup.shown.untrusted });
}

// What the owner's assistant is told, in its owner's language: what arrived, then the event, or
// that their day starts, for a brief, whose turn reads the rest. Of a meeting the harness checks,
// its type tells whether it is a new invitation or a move: only the calendar listener gives one.
function told(wakeup: Wakeup, messages: Messages): string {
	if (wakeup.brief !== undefined) return messages.brief.intro(wakeup.id);
	if (carriesInvitation(wakeup)) {
		return wakeup.type === MOVED_EVENT_TYPE
			? messages.events.moved(wakeup.id, eventData(wakeup), wakeup.invitation.scope ?? 'event')
			: messages.events.invited(wakeup.id, eventData(wakeup));
	}
	return wakeup.type === TASK_ASSIGNED_EVENT_TYPE
		? messages.events.taskAssigned(wakeup.id, eventData(wakeup))
		: messages.events.published(wakeup.type, wakeup.id, eventData(wakeup));
}

function same(a: string | null, b: string | null): boolean {
	return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

// Whether the recipient is the person whose action it was, by either identifier the source gives
function isOwnAction({ actor, recipient }: Wakeup): boolean {
	return same(actor.email, recipient.email) || same(actor.uuid, recipient.uuid);
}

// Wakes the assistant of the person a wake-up is for, its owner: a turn of origin event in their
// room, serialized with their other turns, which tells them of the event it carries, or of origin
// brief for the brief the scheduler asks for. The owner is
// the recipient by their email, which is their principal: only a person of the instance's mail
// domain has one, nobody is woken for their own action, and nobody more often in an hour than the
// deployment allows. An activity of an application their assistant does not listen to, as they
// chose or by its default, wakes nothing and leaves nothing. Their listening journal notes each
// event they are woken for or their cap holds back, and for their brief, with no turn, a task they
// assigned themselves or an activity its source keeps for it, such as a meeting's new title, none
// of which wakes them twice; a brief, which the scheduler tries again, it never notes.
export async function wake(
	deps: WakeDeps,
	wakeup: Wakeup,
	options: WakeOptions = {}
): Promise<WakeOutcome> {
	const { config, db } = deps;
	const owner = wakeup.recipient.email?.toLowerCase() ?? null;
	if (owner === null || matrixLocalpartOfPrincipal(config, owner) === null) return 'ignored';
	// Of the owner's own actions, only a task they assigned themselves, or that their assistant
	// assigned them on their yes, as them, is noted
	const ownAction = isOwnAction(wakeup);
	if (ownAction && wakeup.type !== TASK_ASSIGNED_EVENT_TYPE) return 'ignored';
	// A brief comes from the scheduler's source, and that source brings nothing else: an event
	// published under it is nobody's brief, and takes none of their wake-ups
	if ((wakeup.source === BRIEF_SOURCE) !== (wakeup.brief !== undefined)) return 'ignored';
	// A brief is no activity: the journal notes the others alone
	const isActivity = wakeup.brief === undefined;
	// The application an activity comes from, by the source it was published under: one the
	// harness does not know is listened to by nobody
	const application = isActivity ? sourceOfActivity(wakeup.source) : null;
	const outcome = await withPrincipal(db, { id: owner }, async (tx) => {
		const assistant = await findAssistant(tx, owner);
		if (assistant === null || assistant.deletedAt !== null || assistant.roomId === null) {
			return 'no_assistant' as const;
		}
		// What the owner does not have their assistant listen to reaches neither their room nor
		// their journal, and takes none of their wake-ups
		if (isActivity && (application === null || !(await isListening(tx, owner, application)))) {
			return 'unlistened' as const;
		}
		// One wake-up of an owner at a time, whatever source it comes from: what woke them is settled
		// when it is read, and no two events take the last wake-up of their hour
		await tx.sql`select pg_advisory_xact_lock(hashtext(${`wakeups:${owner}`}))`;
		const [prior] = await tx.sql<{ seen: boolean; woken: number }[]>`
			select
				exists (
					select 1 from wakeups
					where source = ${wakeup.source} and event_id = ${wakeup.id} and owner = ${owner}
				) as seen,
				(
					select count(*)::int from wakeups
					where owner = ${owner} and woken_at > now() - interval '1 hour'
				) as woken`;
		// An owner the event already woke, or whose journal noted it, is not woken again
		if (prior?.seen === true || (await wasNoted(tx, owner, wakeup.source, wakeup.id))) {
			return 'duplicate' as const;
		}
		const noteAs = (journaled: ActivityOutcome): Promise<void> =>
			noteActivity(tx, owner, {
				source: wakeup.source,
				eventId: wakeup.id,
				type: wakeup.type,
				receivedAt: deps.clock.now(),
				outcome: journaled,
				noted: wakeup.noted ?? { ids: NOTHING_SHOWN, names: NOTHING_SHOWN }
			});
		// A task the owner assigned themselves, or an activity its source keeps for their brief, calls
		// for no word at once and takes none of their wake-ups: their journal keeps it for their brief
		if (ownAction || wakeup.forBrief === true) {
			await noteAs('for_brief');
			return 'for_brief' as const;
		}
		// Nor past their hourly cap: a burst of events, a mass assignment or what piled up during an
		// outage, drowns neither their room nor their quota
		if ((prior?.woken ?? 0) >= config.wakeups.perHour) {
			if (isActivity) await noteAs('capped');
			return 'capped' as const;
		}
		// Kept with the turn it queues, or not at all
		await tx.sql`
			insert into wakeups (source, event_id, owner) values (${wakeup.source}, ${wakeup.id}, ${owner})`;
		if (isActivity) await noteAs('woken');
		const key = `event:${JSON.stringify([wakeup.source, wakeup.id, owner])}`;
		const payload: TurnPayload = {
			owner,
			roomId: assistant.roomId,
			eventId: key,
			text: told(wakeup, getMessages(localeOf(assistant, config.locale))),
			origin: wakeup.brief === undefined ? 'event' : 'brief',
			event: {
				id: wakeup.id,
				type: wakeup.type,
				source: wakeup.source,
				...(wakeup.invitation === undefined ? {} : { invitation: wakeup.invitation })
			},
			...(wakeup.brief === undefined ? {} : { brief: wakeup.brief })
		};
		await enqueueJob(tx, { kind: 'turn', payload, dedupKey: key, groupKey: `turn:${owner}` });
		return 'woken' as const;
	});
	const logged = { source: wakeup.source, eventId: wakeup.id, type: wakeup.type, owner };
	if (outcome === 'woken') deps.log.info(logged, 'event queued');
	// A source the harness does not know publishes for nobody: its operator learns which
	if (outcome === 'unlistened' && application === null) {
		deps.log.warn(logged, 'activity of an unknown source, listened to by nobody');
	}
	// Taken all the same, for no turn: nothing tells the owner of an event past their cap
	if (outcome === 'capped' && options.logCapped !== false) deps.log.info(logged, 'event capped');
	// What came of an activity, once settled: one capped or kept for the brief is, one woken once
	// its turn ends
	if ((outcome === 'capped' || outcome === 'for_brief') && isActivity) {
		deps.log.info({ ...logged, outcome }, 'activity noted');
	}
	return outcome;
}
