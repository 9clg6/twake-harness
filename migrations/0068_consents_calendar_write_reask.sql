-- Writing in Calendar now covers declining the invitations the owner received as well as accepting
-- them, a whole series included: every consent to write there was given for less, the pilot's grant
-- (0040) as well as an owner's own yes in chat or through the API. Each is taken back, so that each
-- owner is asked again, in the words the contracts give for writing in Calendar then, the next time
-- their assistant writes there. A request to write there that still waits was asked in the old
-- words: it expires, as one left unanswered past its lifetime does, so that a yes to it runs and
-- allows nothing. Reading Calendar, and every other application, stay as their owners left them.
--
-- Consents and waiting calls are rows under forced row-level security. The table owner lifts the
-- force for these statements, inside the migration's transaction whose locks keep every other
-- session out, and puts it back.
alter table consents no force row level security;
alter table pending_calls no force row level security;

delete from consents where domain = 'calendar' and level = 'write';

update pending_calls set status = 'expired', decided_at = now(), arguments = null,
	request_text = null, preview_digest = null
where domain = 'calendar' and level = 'write' and status = 'open';

alter table pending_calls force row level security;
alter table consents force row level security;
