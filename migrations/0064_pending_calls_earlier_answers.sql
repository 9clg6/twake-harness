-- The events that answered a request before the harness asked it again, once admission kept the
-- yes they carried from running. The request waits for a new answer, yet an earlier one delivered
-- again answers nothing more and starts no turn, as the event that answered it last.
alter table pending_calls add column earlier_answer_event_ids text[] not null default '{}';
