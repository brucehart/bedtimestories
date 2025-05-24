CREATE TABLE stories (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  title     TEXT NOT NULL,
  content   TEXT NOT NULL,
  date      DATE NOT NULL,
  image_url TEXT,
  created   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_stories_date ON stories (date DESC);
CREATE INDEX idx_stories_title_content ON stories(title, content);
CREATE INDEX idx_stories_id ON stories(id);