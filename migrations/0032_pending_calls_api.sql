-- A waiting call remembers the session of the turn that froze it, so that its owner's answer
-- through the API resumes that conversation; a call frozen by a direct tool call through the API
-- has none. It also keeps the harness's question as its owner read it, so that a client shows
-- what waits for the owner's answer in the same words. The question goes with what the call
-- would have sent once the call is decided.
alter table pending_calls
	add column session_id text,
	add column request_text text;
