CREATE TABLE video_posts (
  video_id TEXT PRIMARY KEY NOT NULL REFERENCES videos(id),
  post_url TEXT NOT NULL CHECK (length(post_url) BETWEEN 1 AND 2048)
);

CREATE INDEX video_posts_url ON video_posts(post_url);

CREATE TABLE video_analysis (
  transcript_id TEXT PRIMARY KEY NOT NULL REFERENCES transcripts(id),
  method TEXT NOT NULL,
  sampling_status TEXT NOT NULL CHECK (sampling_status IN ('complete', 'partial', 'unavailable')),
  ocr_status TEXT NOT NULL CHECK (ocr_status IN ('disabled', 'complete', 'partial', 'unavailable')),
  created_at TEXT NOT NULL
);

CREATE TABLE video_frames (
  transcript_id TEXT NOT NULL REFERENCES video_analysis(transcript_id),
  offset_seconds REAL NOT NULL CHECK (offset_seconds >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  ocr_text TEXT CHECK (length(ocr_text) <= 2000),
  PRIMARY KEY (transcript_id, offset_seconds)
);

CREATE TABLE engagement_observations (
  id TEXT PRIMARY KEY NOT NULL,
  video_id TEXT NOT NULL REFERENCES video_posts(video_id),
  source_url TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  limitations_json TEXT NOT NULL CHECK (json_valid(limitations_json) AND json_type(limitations_json) = 'array'),
  views INTEGER CHECK (views >= 0),
  likes INTEGER CHECK (likes >= 0),
  comments INTEGER CHECK (comments >= 0),
  shares INTEGER CHECK (shares >= 0),
  CHECK (views IS NOT NULL OR likes IS NOT NULL OR comments IS NOT NULL OR shares IS NOT NULL),
  UNIQUE (video_id, observed_at, source_url)
);
