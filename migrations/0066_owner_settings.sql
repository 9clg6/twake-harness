-- What the harness keeps of each owner apart from their assistant, which they may not have: for
-- now the zone of their calendar, as the last calendar read that named one returned it, in which
-- their turns state the present. Null until a read named one: the deployment's zone serves until
-- then.
create table owner_settings (
	owner text primary key,
	time_zone text
);

alter table owner_settings enable row level security;
alter table owner_settings force row level security;

create policy owner_settings_owner on owner_settings
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
