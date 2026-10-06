-- The greeting an assistant owes its owner, sent once the owner has joined the room: only then
-- are the owner's devices known, so the greeting can be encrypted for them.
alter table assistant_rooms add column welcome text;
