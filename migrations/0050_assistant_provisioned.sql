-- The owners a provisioner asked an assistant for: an index without user content, like
-- assistant_rooms, so that the matrix role prepares their assistants at its start, room or not.
create table assistant_provisioned (
	owner text primary key,
	user_id text not null
);
