-- The invitee's assistant notes, in their listening journal, one activity per availability request
-- it answers: the source `availability`, a type of the harness's own, and one of two outcomes,
-- answered once it offered the organizer candidate slots or not_shared once it offered none. These
-- extend the table's outcome constraint, its type (ActivityOutcome) and the journal tool's
-- description. The row's display fields are the colleague who asks, the period, the asked time, the
-- duration and the candidate slots given; the purge erases them after a week as every other name,
-- and no word of the conversation is ever kept.
alter table listening_journal drop constraint listening_journal_outcome_check;
alter table listening_journal add constraint listening_journal_outcome_check check (
	outcome in (
		'woken', 'suggested', 'nothing_useful', 'abandoned', 'failed', 'capped', 'for_brief',
		'share_spent', 'quiet_hours', 'answered', 'not_shared'
	)
);
