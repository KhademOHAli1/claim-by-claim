ALTER TABLE engagement_observations ADD COLUMN method TEXT NOT NULL DEFAULT 'manual'
  CHECK (method IN ('manual', 'mastodon-public-api'));

CREATE TABLE source_captures (
  transcript_id TEXT PRIMARY KEY NOT NULL REFERENCES transcripts(id),
  method TEXT NOT NULL CHECK (method IN ('direct-https', 'local-file', 'mastodon-public-api')),
  media_url TEXT,
  captured_at TEXT NOT NULL
);
