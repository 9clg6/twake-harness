-- The question an assistant asks its owner, as long as the deployment only reports, once their words
-- came from a session that another identity than the one held signed: whether they reset their
-- identity themselves. It asks about that identity, in the room those words came to, and waits for
-- the owner's answer until it expires; the words that raised it answer nothing. All null until the
-- owner is first asked.
alter table owner_cross_signing
	add column question_id uuid,
	add column question_master_public_key text,
	add column question_room_id text,
	-- The event of the owner's words that raised it
	add column question_raised_by text,
	-- Stored rather than counted from when it reached the room: its mark told the owner's client
	-- this very end before it went out
	add column question_expires_at timestamptz,
	-- The event that asked it, and when it reached the room, from which it is the room's newest
	-- question: null until it went out
	add column question_event_id text,
	add column question_asked_at timestamptz,
	-- When the owner's next words closed it to typed answers, whether they answered it or not
	add column question_closed_at timestamptz,
	-- What the owner answered, and the event that carried it
	add column question_answer text check (question_answer in ('yes', 'no')),
	add column question_answer_event_id text,
	add constraint owner_cross_signing_question_check check (
		num_nulls(
			question_id,
			question_master_public_key,
			question_room_id,
			question_raised_by,
			question_expires_at
		) in (0, 5)
	);

-- chat: the owner answered yes to that question, which holds the identity it asks about as the API
-- would
alter table owner_cross_signing drop constraint owner_cross_signing_pinned_by_check;
alter table owner_cross_signing add constraint owner_cross_signing_pinned_by_check
	check (pinned_by in ('first_use', 'api', 'chat'));
