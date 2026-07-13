-- Existing deployments only. Fresh databases should use the current schema files.
-- Unknown roles were previously treated as editors, so remove them before adding
-- write-time guards that preserve the reader/editor invariant.
DELETE FROM allowed_accounts WHERE role NOT IN ('reader', 'editor');

CREATE TRIGGER allowed_accounts_valid_role_insert
BEFORE INSERT ON allowed_accounts
WHEN NEW.role NOT IN ('reader', 'editor')
BEGIN
  SELECT RAISE(ABORT, 'allowed_accounts.role must be reader or editor');
END;

CREATE TRIGGER allowed_accounts_valid_role_update
BEFORE UPDATE OF role ON allowed_accounts
WHEN NEW.role NOT IN ('reader', 'editor')
BEGIN
  SELECT RAISE(ABORT, 'allowed_accounts.role must be reader or editor');
END;

ALTER TABLE story_agent_jobs ADD COLUMN callback_token_expires DATETIME;

-- Revoke legacy callback credentials. New jobs receive a one-hour expiry.
UPDATE story_agent_jobs
SET callback_token_hash = '',
    callback_token_expires = datetime('now'),
    status = CASE
      WHEN status IN ('queued', 'starting', 'running') THEN 'failed'
      ELSE status
    END,
    error = CASE
      WHEN status IN ('queued', 'starting', 'running') THEN 'Job revoked during security migration.'
      ELSE error
    END,
    completed = CASE
      WHEN status IN ('queued', 'starting', 'running') THEN COALESCE(completed, datetime('now'))
      ELSE completed
    END,
    updated = datetime('now');

CREATE INDEX idx_story_agent_jobs_callback_expiry
ON story_agent_jobs (callback_token_expires);
