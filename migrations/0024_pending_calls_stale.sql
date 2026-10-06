-- A request left unanswered past its lifetime expires, and a newer request in its room
-- supersedes it: its call is dropped, and what it would have sent is erased
alter table pending_calls drop constraint pending_calls_status_check;
alter table pending_calls
	add constraint pending_calls_status_check
	check (status in ('open', 'approved', 'refused', 'expired', 'superseded'));
