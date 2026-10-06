-- The pilot's assistants read Calendar before consents existed, so their owners keep that and
-- see no question: every principal that could call contracts gets Calendar read. A principal
-- created from now on starts with none, and is asked on first use.
--
-- Rights and consents are rows under forced row-level security. The table owner lifts the force
-- for this one statement, inside the migration's transaction whose locks keep every other
-- session out, and puts it back.
alter table principals no force row level security;
alter table consents no force row level security;

insert into consents (owner, domain, level, granted_by)
select id, 'calendar', 'read', 'migration' from principals where actions ? 'contracts.call'
on conflict do nothing;

alter table consents force row level security;
alter table principals force row level security;
