-- The availability request one assistant writes for another (E2 of the harness's epic #292): the
-- period and the time asked for, the length, and the candidate slots the invitee's assistant
-- answered with. Identifiers, dates and slots only, never a word of the conversation.

-- One row per request: the organizer's assistant writes it, the invitee's assistant answers it, and
-- both read it. It goes once the organizer's suggestion is made or given up, and with the /delete
-- of either.
create table availability_requests (
	id uuid primary key default gen_random_uuid(),
	-- The two colleagues' platform addresses
	organizer text not null,
	invitee text not null,
	-- The listened conversation the request came from, and the message that started it
	room_id text not null,
	event_id text not null,
	-- When the message was written, from which the 10 minutes are counted
	asked_at timestamptz not null,
	-- The requested period, the first day inclusive and the last, null for the day alone
	period_start date not null,
	period_end date,
	-- The asked time, minutes after midnight, or null when none was said
	asked_minutes integer,
	duration_ms integer not null,
	-- The create_meeting call the organizer's model froze at its own first free slot: the fallback
	-- proposes it as it stands when the invitee answered nothing, or too late
	pending_call_id uuid not null,
	-- The answer: the candidate slots, as [{start, end}] in the invitee's zone, or null while no
	-- assistant answered. It is what the organizer's code crosses with its own free/busy, and what
	-- nothing keeps once the suggestion is made.
	answer jsonb,
	answered_at timestamptz,
	created_at timestamptz not null default now(),
	-- One request per message and per invitee: the organizer's job finds it again when it re-reads
	unique (organizer, room_id, event_id)
);
create index availability_requests_invitee_idx on availability_requests (invitee, asked_at);

-- Readable and writable by the organizer and the invitee alone: the two-party shape the harness has
-- nowhere else. The organizer's assistant writes the request, the invitee's assistant writes the
-- answer, and each of them reads both.
alter table availability_requests enable row level security;
alter table availability_requests force row level security;
create policy availability_requests_parties on availability_requests
	using (
		organizer = current_setting('app.principal', true)
		or invitee = current_setting('app.principal', true)
	)
	with check (
		organizer = current_setting('app.principal', true)
		or invitee = current_setting('app.principal', true)
	);
