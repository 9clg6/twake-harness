-- Acting through a contract (any method but GET) now needs its own right, contracts.act, which a
-- turn an event started never holds. Every principal that could call contracts could act through
-- them until now, so it keeps that right: contracts.act is granted wherever contracts.call is,
-- and a principal whose contracts.call was revoked does not get it.
--
-- Rights are rows under forced row-level security, keyed on the principal of the transaction.
-- The table owner lifts the force for this one statement, inside the migration's transaction
-- whose lock on the table keeps every other session out, and puts it back.
alter table principals no force row level security;

update principals
set actions = actions || '["contracts.act"]'::jsonb
where actions ? 'contracts.call' and not actions ? 'contracts.act';

alter table principals force row level security;
