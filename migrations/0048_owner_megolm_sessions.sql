-- When the harness first decrypted words of each owner's Megolm session: the digests of those
-- words are kept for a bounded time, while the session can be decrypted for as long as its key is
-- held, so words of a session first decrypted longer ago than that bound count no more. One row
-- per session, which clients replace at least weekly by default.
create table owner_megolm_sessions (
	owner text not null,
	session_id text not null,
	first_seen_at timestamptz not null default now(),
	primary key (owner, session_id)
);

alter table owner_megolm_sessions enable row level security;
alter table owner_megolm_sessions force row level security;

create policy owner_megolm_sessions_owner on owner_megolm_sessions
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));

-- The owner is told when words of such a session are not taken, at most once a minute per device
alter table owner_device_notices drop constraint owner_device_notices_reason_check;
alter table owner_device_notices add constraint owner_device_notices_reason_check check (
	reason in (
		'unverified', 'no_identity', 'identity_changed', 'check_failed', 'unencrypted', 'old_session'
	)
);
