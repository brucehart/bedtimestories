-- Table to store star ratings for stories by user (or anonymous if no user id)
CREATE TABLE IF NOT EXISTS story_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    story_id INTEGER NOT NULL,
    rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
    created DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Optionally, you could add a user_id or session_id for per-user ratings
    -- user_id TEXT,
    FOREIGN KEY(story_id) REFERENCES stories(id)
);

CREATE INDEX IF NOT EXISTS idx_story_ratings_story_id ON story_ratings(story_id);
