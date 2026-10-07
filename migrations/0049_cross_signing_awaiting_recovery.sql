-- Whether the identity waits for its owner's recovery, after a lost store: a provisioner is told
-- the owner must act, rather than to call again, as for an identity still being prepared.
alter table assistant_cross_signing add column awaiting_recovery boolean not null default false;
