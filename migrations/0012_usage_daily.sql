-- Tokens each owner spent per day, for the daily budget; counted across replicas and restarts.
create table usage_daily (
	owner text not null,
	day date not null,
	tokens bigint not null default 0,
	primary key (owner, day)
);

alter table usage_daily enable row level security;
alter table usage_daily force row level security;

create policy usage_daily_owner on usage_daily
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
