-- When a request was last asked in its room: when its question went out, or when the harness asked
-- it again, once admission kept the yes that answered it from running. Asking a request again
-- supersedes no other request of the room, so the room's questions compare by this time rather
-- than by when their calls froze. A request asked before it was kept counts from when its call
-- froze.
alter table pending_calls add column asked_at timestamptz;
update pending_calls set asked_at = created_at where room_id is not null;
