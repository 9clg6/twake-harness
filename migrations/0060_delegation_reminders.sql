-- The owners the worker role reminded that their permission for their assistant to act for them
-- expires, by the date the broker says they gave it: a pass that runs again, on another day or
-- another replica, reminds nobody twice of the same permission, and the one they give next is
-- reminded of in its turn. Written in the transaction that queues the reminder. Identifiers and
-- dates only: no owner policy, as for the jobs.
create table delegation_reminders (
	owner text not null,
	consented_at timestamptz not null,
	reminded_at timestamptz not null default now(),
	primary key (owner, consented_at)
);
