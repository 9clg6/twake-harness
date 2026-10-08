-- The question an assistant asks its owner, as long as the deployment only reports, once their words
-- came from a session that another identity than the one held signed: whether they reset their
-- identity themselves. It asks about that identity, in the room those words came to, and waits for
-- the owner's answer until it expires; the words that raised it answer nothing. All null until the
-- owner is first asked.
alter table owner_cross_signing
	add column question_id uuid,
	add column question_master_public_key text,
	add column question_room_id text,
	add column question_event_id text,
	add column question_asked_at timestamptz,
	add column question_expires_at timestamptz,
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
			question_event_id,
			question_asked_at,
			question_expires_at
		) in (0, 6)
	);
