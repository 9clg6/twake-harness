-- An owner may tell their assistant to withdraw a consent. Doing so takes a right of its own,
-- consents.withdraw_own, which a turn an event started never holds: the event's text comes from
-- a third party, and only the owner, in a turn of their own, takes back what they allowed. Every
-- principal that can chat gets it.
--
-- Rights are rows under forced row-level security, keyed on the principal of the transaction.
-- The table owner lifts the force for this one statement, inside the migration's transaction
-- whose lock on the table keeps every other session out, and puts it back.
alter table principals no force row level security;

update principals
set actions = actions || '["consents.withdraw_own"]'::jsonb
where actions ? 'chat' and not actions ? 'consents.withdraw_own';

alter table principals force row level security;
