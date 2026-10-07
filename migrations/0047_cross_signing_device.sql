-- The device the cross-signing identity signed: what a client marks verified for the assistant
alter table assistant_cross_signing add column device_id text;
