-- What the assistants propose from the messages of channels that are not encrypted (see
-- Suggestions in the README). Identifiers, dates and slots only, never a message.

-- A member who turns suggestions off: none of their messages is read, and they get none
create table suggestion_settings (
	owner text primary key,
	enabled boolean not null default true
);

-- The rooms a member gets no suggestion from: for good (until is null), or until a date after
-- they found a suggestion not useful
create table suggestion_mutes (
	owner text not null,
	room_id text not null,
	until timestamptz,
	primary key (owner, room_id)
);

-- The suggestions made, which the caps count and a refusal finds again: the channel they came
-- from, the slot they propose, and whether they already are a second try at another time
create table suggestions (
	pending_call_id uuid primary key,
	owner text not null,
	room_id text not null,
	starts_at timestamptz not null,
	ends_at timestamptz not null,
	attempt integer not null default 0,
	created_at timestamptz not null default now()
);
create index suggestions_owner_idx on suggestions (owner, created_at);

alter table suggestion_settings enable row level security;
alter table suggestion_settings force row level security;
create policy suggestion_settings_owner on suggestion_settings
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));

alter table suggestion_mutes enable row level security;
alter table suggestion_mutes force row level security;
create policy suggestion_mutes_owner on suggestion_mutes
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));

alter table suggestions enable row level security;
alter table suggestions force row level security;
create policy suggestions_owner on suggestions
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));

-- The rooms seen to be encrypted: their events, or the state that made them encrypted, reached
-- the application service. Encryption is never turned off, so the list only grows. The matrix
-- role reads it before anything of a channel: no owner policy, as for the jobs.
create table suggestion_encrypted_rooms (
	room_id text primary key,
	seen_at timestamptz not null default now()
);

alter table pending_calls drop constraint pending_calls_origin_check;
alter table pending_calls
	add constraint pending_calls_origin_check check (origin in ('owner', 'event', 'suggestion'));
