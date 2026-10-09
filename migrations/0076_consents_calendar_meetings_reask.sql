-- Reading Calendar now covers finding when the owner and other people are free, from the free and
-- busy times of those others, and writing there covers calling meetings, which emails an invitation
-- to everyone invited, as well as adding events with nobody invited: every consent to read or write
-- there was given for less, an owner's own yes in chat as well as through the API. Each is taken
-- back, so that each owner is asked again, in the words the contracts give for Calendar then, the
-- next time their assistant reads or writes there. A request to read or write there that still
-- waits was asked in the old words: it expires, as one left unanswered past its lifetime does, so
-- that a yes to it runs and allows nothing. Tasks, Mail and every other application stay as their
-- owners left them.
--
-- Consents and waiting calls are rows under forced row-level security. The table owner lifts the
-- force for these statements, inside the migration's transaction whose locks keep every other
-- session out, and puts it back.
alter table consents no force row level security;
alter table pending_calls no force row level security;

delete from consents where domain = 'calendar';

update pending_calls set status = 'expired', decided_at = now(), arguments = null,
	request_text = null, preview_digest = null
where domain = 'calendar' and status = 'open';

alter table pending_calls force row level security;
alter table consents force row level security;
