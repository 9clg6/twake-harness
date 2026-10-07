-- The device the assistant's identity signed, recorded with its master key once it is signed:
-- what a provisioner hands the owner's client, which trusts that device on the identity it
-- checks. Null before any device is signed, and while the identity waits for its recovery.
alter table assistant_cross_signing add column device_id text;
