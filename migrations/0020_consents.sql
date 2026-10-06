-- What an owner let their assistant do in each application: one row per domain (the first
-- segment of a contract id, such as mail) and level (read for GET contracts, write for the
-- others). A contract call in a domain and level its owner never allowed waits for them.
create table consents (
	owner text not null,
	domain text not null,
	level text not null check (level in ('read', 'write')),
	granted_by text not null check (granted_by in ('chat', 'api', 'migration')),
	granted_at timestamptz not null default now(),
	primary key (owner, domain, level)
);

alter table consents enable row level security;
alter table consents force row level security;

create policy consents_owner on consents
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));

-- A contract call the harness froze until its owner answers: the exact call, so that the one
-- the owner allows is the one that runs, never a call the model writes again.
create table pending_calls (
	id uuid primary key default gen_random_uuid(),
	owner text not null,
	tool text not null,
	contract text not null,
	domain text not null,
	level text not null check (level in ('read', 'write')),
	reasons jsonb not null,
	arguments jsonb,
	correlation_id text,
	status text not null default 'open' check (status in ('open')),
	created_at timestamptz not null default now()
);

create index pending_calls_owner_idx on pending_calls (owner, status);

alter table pending_calls enable row level security;
alter table pending_calls force row level security;

create policy pending_calls_owner on pending_calls
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
