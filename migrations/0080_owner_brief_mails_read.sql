-- The instant the owner's last brief read their mail, which their next brief reads their unread
-- mail from; null until a brief read it, the first one reading it from the same time of their wall
-- clock on the last day before it that they have a brief on.
alter table owner_settings
	add column brief_mails_read_at timestamptz;
