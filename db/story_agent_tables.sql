CREATE TABLE story_agent_jobs (
  id                  TEXT PRIMARY KEY,
  requested_by        TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  target_date         DATE,
  status              TEXT NOT NULL DEFAULT 'queued',
  sprite_name         TEXT NOT NULL,
  sprite_session_id   TEXT,
  story_id            INTEGER,
  title               TEXT,
  error               TEXT,
  callback_token_hash TEXT NOT NULL,
  created             DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated             DATETIME DEFAULT CURRENT_TIMESTAMP,
  started             DATETIME,
  completed           DATETIME
);

CREATE INDEX idx_story_agent_jobs_requested_by ON story_agent_jobs (requested_by, created DESC);
CREATE INDEX idx_story_agent_jobs_status ON story_agent_jobs (status, created DESC);

CREATE TABLE story_agent_refs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES story_agent_jobs(id) ON DELETE CASCADE
);

CREATE INDEX idx_story_agent_refs_job_id ON story_agent_refs (job_id, id);

CREATE TABLE story_agent_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message    TEXT NOT NULL,
  metadata   TEXT,
  created    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES story_agent_jobs(id) ON DELETE CASCADE
);

CREATE INDEX idx_story_agent_events_job_id ON story_agent_events (job_id, id);

CREATE TABLE story_agent_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT NOT NULL,
  author_email TEXT NOT NULL,
  content      TEXT NOT NULL,
  created      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES story_agent_jobs(id) ON DELETE CASCADE
);

CREATE INDEX idx_story_agent_messages_job_id ON story_agent_messages (job_id, id);
