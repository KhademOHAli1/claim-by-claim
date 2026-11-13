-- Editorial knowledge graph. These records are reviewable research leads and
-- relationships. Similarity never creates corroboration or merges records.
CREATE TABLE knowledge_nodes (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT REFERENCES cases(id),
  node_type TEXT NOT NULL CHECK (node_type IN (
    'topic', 'claim', 'claim_occurrence', 'narrative', 'entity', 'event',
    'source', 'evidence'
  )),
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  scope TEXT,
  description TEXT,
  search_text TEXT NOT NULL CHECK (length(trim(search_text)) > 0),
  claim_case_id TEXT,
  claim_id TEXT,
  draft_id TEXT,
  occurrence_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(occurrence_json) AND json_type(occurrence_json) = 'object'),
  provenance_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(provenance_json) AND json_type(provenance_json) = 'object'),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  vector_version TEXT NOT NULL,
  vector_json TEXT NOT NULL
    CHECK (json_valid(vector_json) AND json_type(vector_json) = 'array'),
  reviewer TEXT NOT NULL CHECK (length(trim(reviewer)) > 0),
  reviewed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (claim_case_id, claim_id) REFERENCES claims(case_id, id),
  FOREIGN KEY (draft_id) REFERENCES research_drafts(id)
);

CREATE TABLE knowledge_edges (
  id TEXT PRIMARY KEY NOT NULL,
  from_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
  to_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
  relation TEXT NOT NULL CHECK (relation IN (
    'supports', 'contradicts', 'contextualizes', 'same_claim_variant',
    'appears_in', 'quotes', 'derived_from', 'part_of', 'about', 'mentions',
    'related_to'
  )),
  note TEXT,
  provenance_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(provenance_json) AND json_type(provenance_json) = 'object'),
  reviewer TEXT NOT NULL CHECK (length(trim(reviewer)) > 0),
  reviewed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (from_node_id, to_node_id, relation),
  CHECK (from_node_id <> to_node_id)
);

CREATE INDEX knowledge_nodes_type_created
  ON knowledge_nodes(node_type, created_at);
CREATE INDEX knowledge_nodes_case_type
  ON knowledge_nodes(case_id, node_type);
CREATE INDEX knowledge_nodes_claim_ref
  ON knowledge_nodes(claim_case_id, claim_id);
CREATE INDEX knowledge_edges_from
  ON knowledge_edges(from_node_id, relation);
CREATE INDEX knowledge_edges_to
  ON knowledge_edges(to_node_id, relation);
