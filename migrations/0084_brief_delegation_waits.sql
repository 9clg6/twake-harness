-- The brief of an owner's working day that gave way to the harness's question about their
-- permission for their assistant to act for them, the platform's broker holding none or an expired
-- one: the date it is of, and the call that question froze, which their yes resumes as that brief.
-- While it is kept, a brief the broker still refuses says nothing, morning after morning; the next
-- brief that goes out erases it. One per owner at most.
create table brief_delegation_waits (
	owner text primary key,
	brief_date date not null,
	pending_call_id uuid not null
);

alter table brief_delegation_waits enable row level security;
alter table brief_delegation_waits force row level security;
create policy brief_delegation_waits_owner on brief_delegation_waits
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
