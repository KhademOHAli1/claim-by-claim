ALTER TABLE jobs ADD COLUMN lease_token TEXT;
ALTER TABLE jobs ADD COLUMN input_transcript_id TEXT REFERENCES transcripts(id);
ALTER TABLE jobs ADD COLUMN output_transcript_id TEXT REFERENCES transcripts(id);

CREATE UNIQUE INDEX jobs_one_running ON jobs(state) WHERE state = 'running';

CREATE TABLE transcript_approvals (
  video_id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  draft_transcript_id TEXT NOT NULL,
  approved_transcript_id TEXT NOT NULL UNIQUE,
  reviewer TEXT NOT NULL CHECK (length(trim(reviewer)) > 0),
  approved_at TEXT NOT NULL,
  FOREIGN KEY (case_id, video_id) REFERENCES videos(case_id, id),
  FOREIGN KEY (case_id, draft_transcript_id) REFERENCES transcripts(case_id, id),
  FOREIGN KEY (case_id, approved_transcript_id) REFERENCES transcripts(case_id, id)
);

CREATE TABLE research_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  case_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  transcript_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  created_at TEXT NOT NULL,
  FOREIGN KEY (case_id, video_id) REFERENCES videos(case_id, id),
  FOREIGN KEY (case_id, transcript_id) REFERENCES transcripts(case_id, id)
);

CREATE INDEX research_drafts_case ON research_drafts(case_id, created_at);
