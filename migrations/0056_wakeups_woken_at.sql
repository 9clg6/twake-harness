-- The wake-ups by the time they woke their owner, so that the hourly purge finds those past their
-- retention without reading the whole table.
create index wakeups_woken_at_idx on wakeups (woken_at);
