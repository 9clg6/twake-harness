-- Every event the dispatcher posted, by its id: a duplicate makes no second turn, even long
-- after the first one ran. Identifiers only, no user content, so no owner policy.
create table events_seen (
	event_id text primary key,
	owner text not null,
	received_at timestamptz not null default now()
);
