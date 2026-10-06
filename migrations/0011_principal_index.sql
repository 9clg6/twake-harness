-- The principals the harness knows, without rights or content, so the worker role can walk
-- them for its daily curation without reaching into any owner's rows.
create table principal_index (
	owner text primary key,
	created_at timestamptz not null default now()
);
