-- The settings of each owner, kept apart from their assistant, which they may not have. time_zone
-- is the zone of their calendar, in which their turns state the present, as the last successful
-- read of it that named one returned it; null until such a read, the deployment's zone serving
-- until then.
create table owner_settings (
	owner text primary key,
	time_zone text
);

alter table owner_settings enable row level security;
alter table owner_settings force row level security;

create policy owner_settings_owner on owner_settings
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
