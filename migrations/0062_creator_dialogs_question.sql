-- The yes or no question a creator dialog waits on, as the owner's client was told of it: its id,
-- and when it stops taking an answer. The confirmation of a deletion always asks one, and no other
-- step of the dialog does.
alter table creator_dialogs
	add column question_id uuid,
	add column expires_at timestamptz,
	add constraint creator_dialogs_question_check check (
		case state
			when 'confirming_deletion' then question_id is not null and expires_at is not null
			else question_id is null and expires_at is null
		end
	);
