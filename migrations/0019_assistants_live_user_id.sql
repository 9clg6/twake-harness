-- A deleted assistant keeps its row, but no longer holds its Matrix account: only a live assistant
-- owns its user_id, so a new one can take the account. On dev, the row an earlier build left under
-- the owner's old principal (their Matrix localpart), deleted, held the account the owner's new
-- principal (their email) needed, and the creation failed on the plain unique constraint.
alter table assistants drop constraint assistants_user_id_key;
create unique index assistants_live_user_id on assistants (user_id) where deleted_at is null;

-- Taking an account back purges the deleted row that still names it. That row belongs to another
-- principal, which the owner policy hides, so these two policies show and delete it and nothing
-- else: only a deleted row, and only the one account the transaction names in app.reclaim_user_id.
create policy assistants_reclaim_select on assistants for select
	using (deleted_at is not null and user_id = current_setting('app.reclaim_user_id', true));

create policy assistants_reclaim_delete on assistants for delete
	using (deleted_at is not null and user_id = current_setting('app.reclaim_user_id', true));
