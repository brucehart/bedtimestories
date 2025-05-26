CREATE TABLE allowed_accounts (
  email TEXT PRIMARY KEY
);

CREATE INDEX idx_allowed_accounts ON allowed_accounts (email);