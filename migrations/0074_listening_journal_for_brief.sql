-- A task its owner assigns themselves wakes nobody: their journal keeps it for their brief, as
-- for_brief
alter table listening_journal drop constraint listening_journal_outcome_check;
alter table listening_journal add constraint listening_journal_outcome_check check (
	outcome in ('woken', 'suggested', 'nothing_useful', 'abandoned', 'failed', 'capped', 'for_brief')
);
