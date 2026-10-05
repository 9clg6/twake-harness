create table sessions (
	id text primary key,
	owner text not null,
	messages jsonb not null default '[]'::jsonb,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index sessions_owner_idx on sessions (owner, updated_at desc);

alter table sessions enable row level security;
alter table sessions force row level security;

create policy sessions_owner on sessions
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
