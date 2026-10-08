-- The listening journal of each owner: one row per activity a source published for them that the
-- harness took, woken or not, so that they can be told what their assistant saw and what came of
-- it. ids holds what identifies the activity to act on it, and names what shows it, each split
-- into what the source computed and what people wrote; never the text of a message, nor the place
-- or the description of a meeting. names is erased a week after the activity arrived, the row
-- itself once past the wake-ups' retention. received_at is the worker role's present, which a test
-- may set.
create table listening_journal (
	owner text not null,
	source text not null,
	event_id text not null,
	type text not null,
	received_at timestamptz not null,
	-- woken until the turn it woke ends: suggested once it answered, abandoned once it waited too
	-- long for admission, failed otherwise; capped when the owner's hourly cap held it back
	outcome text not null check (outcome in ('woken', 'suggested', 'abandoned', 'failed', 'capped')),
	ids jsonb not null,
	names jsonb,
	primary key (owner, source, event_id)
);

-- What an owner saw since a given time, which the journal lists, and what the purges look for
create index listening_journal_received_idx on listening_journal (owner, received_at);

alter table listening_journal enable row level security;
alter table listening_journal force row level security;

create policy listening_journal_owner on listening_journal
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
