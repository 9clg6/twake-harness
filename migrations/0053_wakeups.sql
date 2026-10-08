-- The owners an event from the broker woke, by its source and id: a redelivery, a restart or a
-- replay of the dead letter queue wakes nobody twice, and two recipients of one event are each
-- woken once. Written in the transaction that queues the turn. Identifiers and dates only, never
-- an event's content, and nothing of a recipient who has no assistant: no owner policy, as for
-- the jobs.
create table wakeups (
	source text not null,
	event_id text not null,
	owner text not null,
	woken_at timestamptz not null default now(),
	primary key (source, event_id, owner)
);
