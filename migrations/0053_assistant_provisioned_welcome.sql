-- Whether a provisioned assistant still owes its owner its greeting, which it gives once, in the
-- first room its owner opens with it, as an assistant the creator conversation makes greets in the
-- room it opens. The assistants provisioned before owe none: the rooms index and the assistant's
-- room both forget a room that stopped being direct, so neither tells an assistant that never had a
-- room from one whose rooms were all left, which would greet its owner twice.
alter table assistant_provisioned add column owes_welcome boolean not null default false;
