-- What the application service must remember across restarts and replicas: the transactions
-- Synapse already delivered, and the virtual users it registered. No user data here.
create table matrix_transactions (
	id text primary key,
	completed_at timestamptz not null default now()
);

create table matrix_registered_users (
	user_id text primary key,
	registered_at timestamptz not null default now()
);
