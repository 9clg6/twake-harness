-- The sources a brief offered each owner to listen to, after it (the harness's spec #306 on
-- listening to the applications): one row per owner and source, written as the brief that makes the
-- source offer goes out. While it stands, no brief offers that source again, whether the owner
-- answered, left it unanswered or a newer question replaced it: they may still ask their assistant
-- to listen there. It goes with their /delete.

create table source_offers (
	owner text not null,
	source text not null,
	-- When the brief made the source offer, which nothing reads: the row's presence alone decides
	offered_at timestamptz not null default now(),
	primary key (owner, source)
);

-- Readable and writable by its owner alone, as what they chose to listen to is
alter table source_offers enable row level security;
alter table source_offers force row level security;
create policy source_offers_owner on source_offers
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));
