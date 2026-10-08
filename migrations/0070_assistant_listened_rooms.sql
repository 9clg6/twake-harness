-- The encrypted direct conversations an assistant joined on its owner's invitation (see
-- Suggestions in the README): it reads them for proposals to its owner alone, and never writes
-- in them
create table assistant_listened_rooms (
	room_id text primary key,
	owner text not null,
	user_id text not null,
	created_at timestamptz not null default now()
);
