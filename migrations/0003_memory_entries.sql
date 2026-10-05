create table memory_entries (
	id bigserial primary key,
	owner text not null,
	target text not null check (target in ('memory', 'user')),
	content text not null,
	created_at timestamptz not null default now()
);

create index memory_entries_owner_idx on memory_entries (owner, target, id);

alter table memory_entries enable row level security;
alter table memory_entries force row level security;

create policy memory_entries_owner on memory_entries
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
