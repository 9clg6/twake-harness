-- Whether an assistant takes its owner's first name at the next start of the matrix role, should it
-- still go by a default name it had before: « Assistant », or the name after its owner's whole
-- Matrix name. The live assistants are flagged once, here. The matrix role clears the flag once the
-- name is settled, renamed or not, and so does a name the owner gives their assistant, so that a
-- name chosen after that, « Assistant » included, stays at every later start. A new assistant goes
-- by the default name of its day, and is never flagged.
--
-- The table owner lifts the forced row-level security for the one statement that flags them, inside
-- the migration's transaction whose lock on the table keeps every other session out, and puts it
-- back.
alter table assistants add column rename_if_former_default boolean not null default false;

alter table assistants no force row level security;

update assistants set rename_if_former_default = true where deleted_at is null;

alter table assistants force row level security;
