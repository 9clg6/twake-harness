-- The events a dispatcher posted to POST /v1/events, by their id, which that route alone read to
-- make one turn of each. Events now come from RabbitMQ alone, and each wake-up is kept in
-- wakeups: nothing reads this table any more. It held identifiers and dates, no content.
drop table if exists events_seen;
