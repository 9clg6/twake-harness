-- A call whose contract showed its owner what it would do keeps the digest of that preview, which
-- the call carries once its owner allowed it, so that its contract refuses it should what it acts
-- on have changed since. Like what the call would send, the digest is erased once the call is
-- decided.
alter table pending_calls add column preview_digest text;
