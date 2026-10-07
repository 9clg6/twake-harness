import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';

import type { TurnPayload } from '../agent/turn-worker.js';
import { localeOf } from '../assistants/locale.js';
import { findAssistant } from '../assistants/repository.js';
import type { Config } from '../config.js';
import { withPrincipal, type Db } from '../db/client.js';
import { getMessages, type Messages } from '../i18n/messages.js';
import { enqueueJob } from '../jobs/queue.js';
import { matrixLocalpartOfPrincipal } from '../principals/identity.js';
import { TASK_ASSIGNED_EVENT_TYPE } from './event-types.js';

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
	readonly shown: {
		readonly computed: Readonly<Record<string, unknown>>;
		readonly untrusted: Readonly<Record<string, unknown>>;
	};
}

export type WakeOutcome = 'woken' | 'duplicate' | 'no_assistant' | 'ignored' | 'capped';

export interface WakeDeps {
	readonly config: Config;
	readonly db: Db;
	readonly log: FastifyBaseLogger;
}

// The event as the model is handed it: one line of JSON, so that nothing a third party wrote can
// start a line of its own, between fences of a random nonce it cannot close
function fenced(wakeup: Wakeup): string {
	const nonce = randomBytes(6).toString('hex');
	const data = JSON.stringify({ ...wakeup.shown.computed, untrusted: wakeup.shown.untrusted });
	return [`<<<event-data ${nonce}`, data, `event-data ${nonce}>>>`].join('\n');
}

// What the owner's assistant is told, in its owner's language: what arrived, then the event
function told(wakeup: Wakeup, messages: Messages): string {
	return wakeup.type === TASK_ASSIGNED_EVENT_TYPE
		? messages.events.taskAssigned(wakeup.id, fenced(wakeup))
		: messages.events.published(wakeup.type, wakeup.id, fenced(wakeup));
}

function same(a: string | null, b: string | null): boolean {
	return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

// Whether the recipient is the person whose action it was, by either identifier the source gives
function isOwnAction({ actor, recipient }: Wakeup): boolean {
	return same(actor.email, recipient.email) || same(actor.uuid, recipient.uuid);
}

// Wakes the assistant of the person a wake-up is for, its owner: a turn of origin event in their
// room, serialized with their other turns, which tells them of the event it carries. The owner is
// the recipient by their email, which is their principal: only a person of the instance's mail
// domain has one, nobody is woken for their own action, and nobody more often in an hour than the
// deployment allows.
export async function wake(deps: WakeDeps, wakeup: Wakeup): Promise<WakeOutcome> {
	const { config, db } = deps;
	const owner = wakeup.recipient.email?.toLowerCase() ?? null;
	if (owner === null || matrixLocalpartOfPrincipal(config, owner) === null) return 'ignored';
	if (isOwnAction(wakeup)) return 'ignored';
	const outcome = await withPrincipal(db, { id: owner }, async (tx) => {
		const assistant = await findAssistant(tx, owner);
		if (assistant === null || assistant.deletedAt !== null || assistant.roomId === null) {
			return 'no_assistant' as const;
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
		// An owner the event already woke is not woken again
		if (prior?.seen === true) return 'duplicate' as const;
		// Nor past their hourly cap: a burst of events, a mass assignment or what piled up during an
		// outage, drowns neither their room nor their quota
		if ((prior?.woken ?? 0) >= config.wakeups.perHour) return 'capped' as const;
		// Kept with the turn it queues, or not at all
		await tx.sql`
			insert into wakeups (source, event_id, owner) values (${wakeup.source}, ${wakeup.id}, ${owner})`;
		const key = `event:${JSON.stringify([wakeup.source, wakeup.id, owner])}`;
		const payload: TurnPayload = {
			owner,
			roomId: assistant.roomId,
			eventId: key,
			text: told(wakeup, getMessages(localeOf(assistant, config.locale))),
			origin: 'event',
			event: { id: wakeup.id, type: wakeup.type }
		};
		await enqueueJob(tx, { kind: 'turn', payload, dedupKey: key, groupKey: `turn:${owner}` });
		return 'woken' as const;
	});
	const logged = { source: wakeup.source, eventId: wakeup.id, type: wakeup.type, owner };
	if (outcome === 'woken') deps.log.info(logged, 'event queued');
	// Taken all the same, for no turn: nothing tells the owner of an event past their cap
	if (outcome === 'capped') deps.log.info(logged, 'event capped');
	return outcome;
}
