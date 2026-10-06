-- The language an owner's assistant, and the harness's own sentences, speak with them: the one
-- they chose by asking their assistant, or else the deployment's
alter table assistants add column locale text;

-- Choosing it takes a right of its own, settings.write_own, which a turn an event started never
-- holds. Every principal that can chat gets it.
--
-- Rights are rows under forced row-level security, keyed on the principal of the transaction.
-- The table owner lifts the force for this one statement, inside the migration's transaction
-- whose lock on the table keeps every other session out, and puts it back.
alter table principals no force row level security;

update principals
set actions = actions || '["settings.write_own"]'::jsonb
where actions ? 'chat' and not actions ? 'settings.write_own';

alter table principals force row level security;
