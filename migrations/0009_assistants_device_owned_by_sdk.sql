-- The application service drives each assistant as one of its devices, which the Matrix SDK
-- creates and keeps; the harness holds no device token of its own for an assistant.
alter table assistants drop column device_id;
alter table assistants drop column access_token;
