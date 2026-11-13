-- Editorial metadata only. Source files and media are referenced, never stored here.
CREATE TABLE cases (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  stage TEXT NOT NULL DEFAULT 'submitted' CHECK (stage IN (
    'submitted', 'transcribing', 'needs_transcript_review', 'researching',
    'needs_editor', 'approved', 'archived'
  )),
  created_at TEXT NOT NULL,
  as_of TEXT,
  review_note TEXT,
  scope_notes_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(scope_notes_json) AND json_type(scope_notes_json) = 'array')
);

CREATE TABLE videos (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL REFERENCES cases(id),
  source_ref TEXT NOT NULL CHECK (length(trim(source_ref)) > 0),
  created_at TEXT NOT NULL,
  duration_seconds REAL CHECK (duration_seconds > 0),
  poster_ref TEXT,
  captions_ref TEXT,
  sha256 TEXT CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER CHECK (size_bytes >= 0),
  UNIQUE (case_id, id)
);

CREATE TABLE transcripts (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  language TEXT NOT NULL,
  provisional INTEGER NOT NULL DEFAULT 1 CHECK (provisional IN (0, 1)),
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (case_id, id),
  FOREIGN KEY (case_id, video_id) REFERENCES videos(case_id, id)
);

CREATE TABLE transcript_segments (
  case_id TEXT NOT NULL,
  transcript_id TEXT NOT NULL,
  id TEXT NOT NULL,
  start_seconds REAL NOT NULL CHECK (start_seconds >= 0),
  end_seconds REAL NOT NULL CHECK (end_seconds > start_seconds),
  text TEXT NOT NULL,
  words_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(words_json) AND json_type(words_json) = 'array'),
  PRIMARY KEY (case_id, transcript_id, id),
  FOREIGN KEY (case_id, transcript_id) REFERENCES transcripts(case_id, id)
);

CREATE TABLE claims (
  case_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  id TEXT NOT NULL,
  start_seconds REAL NOT NULL CHECK (start_seconds >= 0),
  end_seconds REAL NOT NULL CHECK (end_seconds > start_seconds),
  quote TEXT NOT NULL,
  category TEXT,
  scope TEXT,
  verdict TEXT CHECK (verdict IN (
    'Supported', 'Contradicted', 'Misleading', 'Mixed', 'Unsubstantiated',
    'Unresolved', 'Not fact-checkable'
  )),
  status TEXT CHECK (status IN ('green', 'red', 'orange', 'neutral')),
  confidence TEXT CHECK (confidence IN ('High', 'Medium', 'Low')),
  confidence_reason TEXT,
  finding TEXT,
  counterevidence TEXT,
  unresolved TEXT,
  next_test TEXT,
  review_status TEXT,
  PRIMARY KEY (case_id, id),
  FOREIGN KEY (case_id, video_id) REFERENCES videos(case_id, id)
);

CREATE TABLE sources (
  case_id TEXT NOT NULL REFERENCES cases(id),
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  published TEXT,
  pinpoint TEXT,
  origin_group TEXT,
  establishes TEXT,
  limits TEXT,
  inspected INTEGER NOT NULL DEFAULT 0 CHECK (inspected IN (0, 1)),
  locations_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(locations_json) AND json_type(locations_json) = 'array'),
  usage_limit_words INTEGER CHECK (usage_limit_words >= 0),
  PRIMARY KEY (case_id, id)
);

CREATE TABLE evidence (
  case_id TEXT NOT NULL REFERENCES cases(id),
  id TEXT NOT NULL,
  source_id TEXT,
  retention_status TEXT NOT NULL,
  repository_path TEXT,
  sha256 TEXT CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER CHECK (size_bytes >= 0),
  publication_copy INTEGER NOT NULL DEFAULT 0 CHECK (publication_copy IN (0, 1)),
  preview_json TEXT CHECK (json_valid(preview_json) AND json_type(preview_json) = 'object'),
  registry_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(registry_json) AND json_type(registry_json) = 'object'),
  PRIMARY KEY (case_id, id),
  FOREIGN KEY (case_id, source_id) REFERENCES sources(case_id, id)
);

CREATE TABLE claim_evidence (
  case_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('supporting', 'contradicting', 'context')),
  PRIMARY KEY (case_id, claim_id, evidence_id, relation),
  FOREIGN KEY (case_id, claim_id) REFERENCES claims(case_id, id),
  FOREIGN KEY (case_id, evidence_id) REFERENCES evidence(case_id, id)
);

-- A human reviewer can describe a moment and link a retained frame in the registry.
CREATE TABLE visual_observations (
  case_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  id TEXT NOT NULL,
  timestamp_seconds REAL NOT NULL CHECK (timestamp_seconds >= 0),
  observation TEXT NOT NULL CHECK (length(trim(observation)) > 0),
  evidence_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (case_id, id),
  FOREIGN KEY (case_id, video_id) REFERENCES videos(case_id, id),
  FOREIGN KEY (case_id, evidence_id) REFERENCES evidence(case_id, id)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY NOT NULL,
  video_id TEXT NOT NULL REFERENCES videos(id),
  kind TEXT NOT NULL CHECK (kind IN ('transcribe', 'research')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled'
  )),
  created_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_expires_at TEXT,
  finished_at TEXT,
  last_error TEXT
);

CREATE INDEX cases_stage_created_at ON cases(stage, created_at);
CREATE INDEX videos_source_ref ON videos(source_ref);
CREATE INDEX transcripts_video ON transcripts(case_id, video_id);
CREATE INDEX transcript_segments_time ON transcript_segments(case_id, transcript_id, start_seconds);
CREATE INDEX claims_video_time ON claims(case_id, video_id, start_seconds);
CREATE INDEX evidence_source ON evidence(case_id, source_id);
CREATE INDEX claim_evidence_by_evidence ON claim_evidence(case_id, evidence_id);
CREATE INDEX visual_observations_video_time ON visual_observations(case_id, video_id, timestamp_seconds);
CREATE INDEX jobs_state_created_at ON jobs(state, created_at);
CREATE INDEX jobs_video ON jobs(video_id);
CREATE UNIQUE INDEX jobs_one_active_per_kind ON jobs(video_id, kind)
  WHERE state IN ('queued', 'running');
