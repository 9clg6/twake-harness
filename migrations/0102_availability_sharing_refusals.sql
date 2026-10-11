-- A refusal an invitee kept of the harness's question about sharing their availability with
-- colleagues (E2 of the harness's epic #292). One row per owner: while it stands, the harness asks
-- them nothing more, and their assistant answers the requests it already holds as when no sharing
-- was ever allowed. It goes when they let their assistant share their availability, when they take
-- that sharing back on the agreements page, or with their /delete.

create table availability_sharing_refusals (
	-- The invitee who refused, and whose assistant asks them nothing more while this stands
	owner text primary key,
	-- When they refused, which nothing reads: the row's presence alone decides
	refused_at timestamptz not null default now()
);

-- Readable and writable by its owner alone, as the permissions they gave their assistant are
alter table availability_sharing_refusals enable row level security;
alter table availability_sharing_refusals force row level security;
create policy availability_sharing_refusals_owner on availability_sharing_refusals
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
