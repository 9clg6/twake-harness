-- Work handed from one role to another: a Matrix message becomes a turn for the api role, its
-- answer a send for the matrix role. The payload carries the message text while the job lives;
-- the rows are reaped once done. Any replica may claim any job, so this table has no owner policy.
create table jobs (
	id bigserial primary key,
	kind text not null,
	payload jsonb not null,
	dedup_key text unique,
	status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
	attempts int not null default 0,
	run_after timestamptz not null default now(),
	locked_by text,
	locked_at timestamptz,
	last_error text,
	created_at timestamptz not null default now(),
	finished_at timestamptz
);

create index jobs_claim_idx on jobs (kind, status, run_after, id);

-- Which assistant owns which room: an index without user content, so the matrix role can route
-- a room event to its owner before any owner-scoped access.
create table assistant_rooms (
	room_id text primary key,
	owner text not null,
	user_id text not null
);

alter table sessions add column room_id text;
create unique index sessions_owner_room_idx on sessions (owner, room_id) where room_id is not null;
