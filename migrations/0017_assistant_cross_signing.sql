-- The cross-signing identity the harness holds for an assistant, by its public master key: a
-- master key on the homeserver that is not this one belongs to someone else, and is replaced.
create table assistant_cross_signing (
	owner text primary key,
	master_public_key text not null,
	signed_at timestamptz not null default now()
);

alter table assistant_cross_signing enable row level security;
alter table assistant_cross_signing force row level security;

create policy assistant_cross_signing_owner on assistant_cross_signing
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
