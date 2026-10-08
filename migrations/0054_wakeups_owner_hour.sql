-- The wake-ups of an owner since a given time, which the hourly cap counts before each new one
create index wakeups_owner_idx on wakeups (owner, woken_at);
