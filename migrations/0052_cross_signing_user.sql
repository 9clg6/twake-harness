-- The assistant the identity was recorded for: an owner whose assistant changed identifier, after a
-- change of the assistants' prefix, must not be handed the keys of the former one. Rows from before
-- learn theirs at the next cross-signing.
alter table assistant_cross_signing add column user_id text;
