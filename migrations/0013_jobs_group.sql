-- Jobs of one group run one after the other, in the order they were queued, whichever replica
-- claims them: the turns of one owner, the answers of one room.
alter table jobs add column group_key text;
create index jobs_group_idx on jobs (group_key, id) where group_key is not null;
