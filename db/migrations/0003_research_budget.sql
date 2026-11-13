ALTER TABLE jobs ADD COLUMN started_at TEXT;

CREATE INDEX jobs_research_started_at ON jobs(started_at)
  WHERE kind = 'research' AND started_at IS NOT NULL;
