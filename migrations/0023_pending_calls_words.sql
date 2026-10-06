-- A request belongs to the room it was asked in. Its owner's yes or no in words answers it only as
-- their next message after it: once they wrote anything else, only a reaction does. The event
-- that answered a request is kept, so that the same event delivered again answers nothing more
-- and starts no turn.
alter table pending_calls
	add column room_id text,
	add column words_closed_at timestamptz,
	add column answer_event_id text;

create index pending_calls_room_idx on pending_calls (owner, room_id, status);
create index pending_calls_answer_idx on pending_calls (owner, answer_event_id);

-- An owner may refuse a call: it is then dropped, and what it would have sent is erased
alter table pending_calls drop constraint pending_calls_status_check;
alter table pending_calls
	add constraint pending_calls_status_check check (status in ('open', 'approved', 'refused'));
