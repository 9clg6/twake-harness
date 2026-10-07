-- Whether a provisioned assistant still owes its owner its greeting, which it gives once, in the
-- first room its owner opens with it, as an assistant the creator conversation makes greets in the
-- room it opens. An assistant provisioned before, with no room yet, still owes it.
alter table assistant_provisioned add column owes_welcome boolean not null default false;

update assistant_provisioned p set owes_welcome = true
where not exists (select 1 from assistant_rooms r where r.owner = p.owner);
