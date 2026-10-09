-- What each owner chose of their morning brief, next to the zone of their calendar, null where they
-- kept the default. brief_time is the time it is due, in minutes after midnight on their wall
-- clock, on the quarter hour: eight o'clock by default. brief_days are the days of the week it
-- goes out, one at least: Monday to Friday by default. brief_paused_until is the date it goes out
-- again after a pause, none before it. brief_stopped holds it back until its owner resumes it.
alter table owner_settings
	add column brief_time smallint check (brief_time between 0 and 1425 and brief_time % 15 = 0),
	add column brief_days text[] check (
		cardinality(brief_days) > 0
		and brief_days <@ array['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
	),
	add column brief_paused_until date,
	add column brief_stopped boolean not null default false;
