-- Turns started in the last minute, per owner and for the whole harness: the rate limits hold
-- across replicas. A row per second; rows older than the window are pruned as they are read.
create table usage_window (
	owner text not null,
	at timestamptz not null,
	turns int not null default 0,
	primary key (owner, at)
);

alter table usage_window enable row level security;
alter table usage_window force row level security;

create policy usage_window_owner on usage_window
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));

-- The rate of the whole harness has no owner, so this table has no owner policy
create table usage_window_global (
	at timestamptz primary key,
	turns int not null default 0
);
