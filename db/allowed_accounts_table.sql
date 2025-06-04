CREATE TABLE allowed_accounts (
  email TEXT PRIMARY KEY,
  role  TEXT NOT NULL DEFAULT 'editor'
);

CREATE INDEX idx_allowed_accounts ON allowed_accounts (email);
