-- A turn an activity woke may end on no words, when it found nothing useful to say: the activity
-- is then nothing_useful
alter table listening_journal drop constraint listening_journal_outcome_check;
alter table listening_journal add constraint listening_journal_outcome_check check (
	outcome in ('woken', 'suggested', 'nothing_useful', 'abandoned', 'failed', 'capped')
);
