-- Per-user values the Matrix SDK keeps for the virtual users it drives, such as the access
-- token of a device it logged in. No conversation content.
create table matrix_user_storage (
	user_id text not null,
	key text not null,
	value text not null,
	primary key (user_id, key)
);
