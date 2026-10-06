-- What the harness keeps about an assistant's escrow: where it is in OpenBao, the public part of
-- the identity and the backup version. The secrets themselves never land here.
create table assistant_escrow (
	owner text primary key,
	path text not null,
	master_public_key text not null,
	backup_version text not null,
	escrowed_at timestamptz not null default now(),
	recovered_at timestamptz
);

alter table assistant_escrow enable row level security;
alter table assistant_escrow force row level security;

create policy assistant_escrow_owner on assistant_escrow
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
