-- The yes or no question a creator dialog waits on, as the owner's client was told of it: its id,
-- and when it stops taking an answer. Only the confirmation of a deletion asks one.
alter table creator_dialogs
	add column question_id uuid,
	add column expires_at timestamptz;
