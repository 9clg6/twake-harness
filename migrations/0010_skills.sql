-- Skills in the Agent Skills format, one library per user and one for the organization. A
-- proposal is a skill waiting for approval. Users read their own and the organization's;
-- the organization's are written by administrators only, who also see proposals to promote.
create table skills (
	id text primary key,
	scope text not null check (scope in ('user', 'org')),
	owner text not null,
	name text not null,
	description text not null,
	content text not null,
	status text not null default 'active' check (status in ('active', 'proposed', 'rejected')),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index skills_owner_idx on skills (owner, scope, status);

alter table skills enable row level security;
alter table skills force row level security;

create policy skills_read on skills for select
	using (
		(scope = 'user' and owner = current_setting('app.principal', true))
		or (scope = 'org' and status = 'active')
		or current_setting('app.admin', true) = 'true'
	);

create policy skills_write_own on skills for insert
	with check (scope = 'user' and owner = current_setting('app.principal', true));

create policy skills_update_own on skills for update
	using (scope = 'user' and owner = current_setting('app.principal', true))
	with check (scope = 'user' and owner = current_setting('app.principal', true));

create policy skills_delete_own on skills for delete
	using (scope = 'user' and owner = current_setting('app.principal', true));

create policy skills_admin_insert on skills for insert
	with check (scope = 'org' and current_setting('app.admin', true) = 'true');

create policy skills_admin_update on skills for update
	using (scope = 'org' and current_setting('app.admin', true) = 'true')
	with check (scope = 'org' and current_setting('app.admin', true) = 'true');

create policy skills_admin_delete on skills for delete
	using (scope = 'org' and current_setting('app.admin', true) = 'true');
