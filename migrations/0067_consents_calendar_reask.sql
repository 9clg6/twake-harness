-- Reading Calendar now covers the owner's events, private ones included, and no longer their free
-- and busy times alone: every consent to read it was given for less, the pilot's grant (0021) as
-- well as an owner's own yes in chat or through the API. Each is taken back, so that each owner is
-- asked again, in the words the contracts give for reading Calendar then, the next time their
-- assistant reads it. Calendar write, and every other application, stay as their owners left them.
--
-- Consents are rows under forced row-level security. The table owner lifts the force for this one
-- statement, inside the migration's transaction whose locks keep every other session out, and puts
-- it back.
alter table consents no force row level security;

delete from consents where domain = 'calendar' and level = 'read';

alter table consents force row level security;
