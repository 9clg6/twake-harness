-- A job its handler could not run yet, such as the turn of an event that admission refused, is
-- deferred: it waits out of its group's way, holding back none of the jobs queued behind it, and
-- comes back at the end of its group once due. How many times it was deferred sets how long it
-- waits the next time, and when it was first deferred how long it may still wait.
alter table jobs drop constraint jobs_status_check;
alter table jobs add constraint jobs_status_check
	check (status in ('queued', 'running', 'deferred', 'done', 'failed'));
alter table jobs add column deferrals int not null default 0;
alter table jobs add column first_deferred_at timestamptz;
