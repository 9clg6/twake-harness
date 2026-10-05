-- One assistant per owner. The owner is the principal, the same identity as the OIDC subject
-- and as the localpart of the owner's Matrix identifier.
create table assistants (
	owner text primary key,
	user_id text not null unique,
	name text not null,
	device_id text not null,
	access_token text not null,
	room_id text,
	created_at timestamptz not null default now(),
	deleted_at timestamptz
);

alter table assistants enable row level security;
alter table assistants force row level security;

create policy assistants_owner on assistants
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));

-- Where the creator conversation of an owner stands, across restarts
create table creator_dialogs (
	owner text primary key,
	state text not null,
	updated_at timestamptz not null default now()
);

alter table creator_dialogs enable row level security;
alter table creator_dialogs force row level security;

create policy creator_dialogs_owner on creator_dialogs
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
