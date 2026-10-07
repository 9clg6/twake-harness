-- The cross-signing identity of each owner, by its public master key, as the harness first saw it
-- published, or as the owner accepted it since through the API: an owner's words count only from
-- a device that identity signed.
create table owner_cross_signing (
	owner text primary key,
	master_public_key text not null,
	-- first_use: the harness held the identity it first saw; api: the owner accepted it
	pinned_by text not null check (pinned_by in ('first_use', 'api')),
	pinned_at timestamptz not null default now(),
	-- The identity that signed the session the owner's words last came from, when it was another
	-- one than the one held, and when: the owner accepts it through the API. Both are null
	-- otherwise.
	seen_master_public_key text,
	seen_at timestamptz,
	check ((seen_master_public_key is null) = (seen_at is null))
);

alter table owner_cross_signing enable row level security;
alter table owner_cross_signing force row level security;

create policy owner_cross_signing_owner on owner_cross_signing
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));

-- When the owner was last told that their words came from a device the harness cannot take them
-- from, per device and reason, so that the notice is not repeated at every message
create table owner_device_notices (
	owner text not null,
	-- The device's id, or its identity key when the device is not known
	device text not null,
	reason text not null check (
		reason in ('unverified', 'no_identity', 'identity_changed', 'check_failed')
	),
	notified_at timestamptz not null default now(),
	primary key (owner, device, reason)
);

alter table owner_device_notices enable row level security;
alter table owner_device_notices force row level security;

create policy owner_device_notices_owner on owner_device_notices
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
