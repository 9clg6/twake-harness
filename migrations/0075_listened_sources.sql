-- What each owner chose their assistant to listen to, source by source: listening is their latest
-- choice for that source. A source they never chose for keeps its default, Calendar and Tasks
-- listened to, any other not.
create table listened_sources (
	owner text not null,
	source text not null,
	listening boolean not null,
	primary key (owner, source)
);

alter table listened_sources enable row level security;
alter table listened_sources force row level security;

create policy listened_sources_owner on listened_sources
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
