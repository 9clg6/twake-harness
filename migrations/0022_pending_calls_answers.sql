-- A waiting call remembers who started the turn that froze it, so that the turn its owner's
-- answer resumes may do no more than that one could: a turn an event started never acts. It also
-- remembers the Matrix event of its question, which the answer points to. Once its owner allowed
-- it, it is approved, and once it ran and the conversation holds it, replayed: an approved call
-- not yet replayed, after a crash, runs when its answer's job runs again.
alter table pending_calls
	add column origin text not null default 'owner' check (origin in ('owner', 'event')),
	add column request_event_id text,
	add column decided_at timestamptz,
	add column replayed_at timestamptz;

alter table pending_calls drop constraint pending_calls_status_check;
alter table pending_calls
	add constraint pending_calls_status_check check (status in ('open', 'approved'));

create index pending_calls_request_idx on pending_calls (owner, request_event_id);
