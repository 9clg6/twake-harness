-- The yes or no question a creator dialog waits on, as the owner's client was told of it: its id,
-- and when it stops taking an answer; with the assistant it asks about, by when that one was
-- created, which tells it from one its owner deleted and created again since under the same
-- account. The confirmation of a deletion always asks one, and no other step of the dialog does.
alter table creator_dialogs
	add column question_id uuid,
	add column expires_at timestamptz,
	add column assistant_created_at timestamptz,
	add constraint creator_dialogs_question_check check (
		case state
			when 'confirming_deletion' then
				question_id is not null and expires_at is not null and assistant_created_at is not null
			else question_id is null and expires_at is null and assistant_created_at is null
		end
	);
