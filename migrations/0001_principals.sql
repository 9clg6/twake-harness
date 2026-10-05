-- Every table that holds user data carries an owner and a row-level security policy keyed on
-- the principal that the current transaction set. Forcing RLS applies it to the table owner too,
-- so the application role never bypasses it.
create table principals (
	id text primary key,
	actions jsonb not null,
	created_at timestamptz not null default now()
);

alter table principals enable row level security;
alter table principals force row level security;

create policy principals_owner on principals
	using (id = current_setting('app.principal', true))
	with check (id = current_setting('app.principal', true));
