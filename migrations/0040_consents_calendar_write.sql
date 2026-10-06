-- The pilot's assistants accepted invitations before writing in an application asked its owner,
-- so their owners keep that and see no question: every principal that may act through contracts
-- gets Calendar write. A principal created from now on starts with none, and is asked on its
-- assistant's first write there.
--
-- Rights and consents are rows under forced row-level security. The table owner lifts the force
-- for this one statement, inside the migration's transaction whose locks keep every other
-- session out, and puts it back.
alter table principals no force row level security;
alter table consents no force row level security;

insert into consents (owner, domain, level, granted_by)
select id, 'calendar', 'write', 'migration' from principals where actions ? 'contracts.act'
on conflict do nothing;

alter table consents force row level security;
alter table principals force row level security;
