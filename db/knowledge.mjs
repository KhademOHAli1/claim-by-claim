const vectorVersion = 'hashed-lexical-v1-96';
const vectorDimension = 96;
const defaultLimit = 20;
const maxLimit = 50;

const nodeTypes = new Set([
  'topic', 'claim', 'claim_occurrence', 'narrative', 'entity', 'event', 'source', 'evidence',
]);
const edgeRelations = new Set([
  'supports', 'contradicts', 'contextualizes', 'same_claim_variant', 'appears_in',
  'quotes', 'derived_from', 'part_of', 'about', 'mentions', 'related_to',
]);

function statement(sql, ...params) {
  return { sql, params };
}

function first(rows) {
  return rows?.[0] ?? null;
}

function requiredText(value, field, max = 10_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function jsonObject(value, field) {
  if (value === undefined || value === null) return '{}';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return JSON.stringify(value);
}

function optionalId(value, field) {
  if (value === undefined || value === null) return null;
  return requiredText(value, field, 200);
}

function fnv1a(value) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash >>> 0;
}

function lexicalTokens(value) {
  return (value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => token.length > 1);
}

/**
 * A small, deterministic lexical vector for local/D1 retrieval leads. It has
 * no language model semantics and must not be treated as corroboration.
 */
export function lexicalVector(value) {
  const tokens = lexicalTokens(String(value ?? ''));
  const vector = Array.from({ length: vectorDimension }, () => 0);
  const features = [...tokens];
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    features.push(`${tokens[index]}\u0000${tokens[index + 1]}`);
  }
  for (const feature of features) {
    const hash = fnv1a(feature);
    const slot = hash % vectorDimension;
    const sign = (hash & 0x8000_0000) === 0 ? 1 : -1;
    vector[slot] += sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, valueAtSlot) => sum + valueAtSlot ** 2, 0));
  if (norm > 0) return vector.map((valueAtSlot) => valueAtSlot / norm);
  return vector;
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = Number(left[index]);
    const rightValue = Number(right[index]);
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue ** 2;
    rightNorm += rightValue ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function nodeSearchText(record) {
  return [record.label, record.scope, record.description, record.text, record.quote]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n')
    .trim();
}

function normalizeClaimRef(record) {
  const claimRef = record.claimRef ?? record.claim ?? null;
  if (!claimRef) return { claimCaseId: null, claimId: null, draftId: null, occurrence: {} };
  if (typeof claimRef !== 'object' || Array.isArray(claimRef)) {
    throw new Error('claimRef must be an object.');
  }
  return {
    claimCaseId: optionalId(claimRef.caseId ?? claimRef.case_id, 'claimRef.caseId'),
    claimId: optionalId(claimRef.claimId ?? claimRef.claim_id, 'claimRef.claimId'),
    draftId: optionalId(claimRef.draftId ?? claimRef.draft_id, 'claimRef.draftId'),
    occurrence: claimRef.occurrence && typeof claimRef.occurrence === 'object'
      ? claimRef.occurrence
      : {},
  };
}

function decodeNode(row) {
  if (!row) return null;
  const parse = (value, fallback) => {
    try { return JSON.parse(value); } catch { return fallback; }
  };
  const { vector_json, occurrence_json, provenance_json, metadata_json, ...node } = row;
  return {
    ...node,
    caseId: node.case_id,
    nodeType: node.node_type,
    searchText: node.search_text,
    claimCaseId: node.claim_case_id,
    claimId: node.claim_id,
    draftId: node.draft_id,
    vectorVersion: node.vector_version,
    vector: parse(vector_json, []),
    occurrence: parse(occurrence_json, {}),
    provenance: parse(provenance_json, {}),
    metadata: parse(metadata_json, {}),
    reviewedAt: node.reviewed_at,
    createdAt: node.created_at,
    updatedAt: node.updated_at,
  };
}

function decodeEdge(row) {
  if (!row) return null;
  const { provenance_json, ...edge } = row;
  let provenance = {};
  try { provenance = JSON.parse(provenance_json); } catch { /* schema guards this */ }
  return { ...edge, provenance, reviewedAt: edge.reviewed_at, createdAt: edge.created_at };
}

/** A batch adapter accepts `{sql, params}` and returns one row array per statement. */
export function createKnowledgeStore(batch, { clock = Date.now } = {}) {
  if (typeof batch !== 'function') throw new Error('A D1/SQLite batch adapter is required.');
  const timestamp = () => new Date(clock()).toISOString();

  async function putKnowledgeNode(record, reviewer) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('A node record is required.');
    const nodeType = requiredText(record.nodeType ?? record.type, 'nodeType', 40);
    if (!nodeTypes.has(nodeType)) throw new Error(`Unknown knowledge node type: ${nodeType}.`);
    const label = requiredText(record.label, 'label', 2000);
    const reviewerName = requiredText(reviewer, 'reviewer', 200);
    const id = optionalId(record.id, 'id') ?? crypto.randomUUID();
    const caseId = optionalId(record.caseId ?? record.case_id, 'caseId');
    const scope = record.scope === undefined || record.scope === null ? null : requiredText(record.scope, 'scope', 5000);
    if ((nodeType === 'topic' || nodeType === 'narrative') && scope === null) {
      throw new Error('A topic or narrative needs an editorial scope.');
    }
    const description = record.description === undefined || record.description === null
      ? null : requiredText(record.description, 'description', 20_000);
    const searchText = nodeSearchText({ ...record, label, scope, description });
    const claimRef = normalizeClaimRef(record);
    if ((claimRef.claimCaseId === null) !== (claimRef.claimId === null)) {
      throw new Error('claimRef.caseId and claimRef.claimId must be provided together.');
    }
    const provenance = jsonObject(record.provenance, 'provenance');
    const metadata = jsonObject(record.metadata, 'metadata');
    const vector = JSON.stringify(lexicalVector(searchText));
    const now = timestamp();
    const [rows] = await batch([statement(`
      INSERT INTO knowledge_nodes (
        id, case_id, node_type, label, scope, description, search_text,
        claim_case_id, claim_id, draft_id, occurrence_json, provenance_json,
        metadata_json, vector_version, vector_json, reviewer, reviewed_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        case_id = excluded.case_id, node_type = excluded.node_type,
        label = excluded.label, scope = excluded.scope,
        description = excluded.description, search_text = excluded.search_text,
        claim_case_id = excluded.claim_case_id, claim_id = excluded.claim_id,
        draft_id = excluded.draft_id, occurrence_json = excluded.occurrence_json,
        provenance_json = excluded.provenance_json, metadata_json = excluded.metadata_json,
        vector_version = excluded.vector_version, vector_json = excluded.vector_json,
        reviewer = excluded.reviewer, reviewed_at = excluded.reviewed_at,
        updated_at = excluded.updated_at
      RETURNING *
    `, id, caseId, nodeType, label, scope, description, searchText,
      claimRef.claimCaseId, claimRef.claimId, claimRef.draftId,
      JSON.stringify(claimRef.occurrence), provenance, metadata,
      vectorVersion, vector, reviewerName, now, now, now)]);
    const node = decodeNode(first(rows));
    if (!node) throw new Error('Knowledge node was not recorded.');
    return node;
  }

  async function linkKnowledgeNodes(record, reviewer) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('An edge record is required.');
    const fromNodeId = requiredText(record.fromNodeId ?? record.from, 'fromNodeId', 200);
    const toNodeId = requiredText(record.toNodeId ?? record.to, 'toNodeId', 200);
    if (fromNodeId === toNodeId) throw new Error('A knowledge edge must connect two different nodes.');
    const relation = requiredText(record.relation, 'relation', 80);
    if (!edgeRelations.has(relation)) throw new Error(`Unknown knowledge edge relation: ${relation}.`);
    const reviewerName = requiredText(reviewer, 'reviewer', 200);
    const id = optionalId(record.id, 'id') ?? crypto.randomUUID();
    const note = record.note === undefined || record.note === null ? null : requiredText(record.note, 'note', 10_000);
    const provenance = jsonObject(record.provenance, 'provenance');
    const now = timestamp();
    const [rows] = await batch([statement(`
      INSERT INTO knowledge_edges (
        id, from_node_id, to_node_id, relation, note, provenance_json,
        reviewer, reviewed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(from_node_id, to_node_id, relation) DO UPDATE SET
        note = excluded.note, provenance_json = excluded.provenance_json,
        reviewer = excluded.reviewer, reviewed_at = excluded.reviewed_at
      RETURNING *
    `, id, fromNodeId, toNodeId, relation, note, provenance, reviewerName, now, now)]);
    const edge = decodeEdge(first(rows));
    if (!edge) throw new Error('Knowledge edge was not recorded.');
    return edge;
  }

  async function knowledgeNode(id) {
    const nodeId = requiredText(id, 'id', 200);
    const [rows, edgesFrom, edgesTo] = await batch([
      statement('SELECT * FROM knowledge_nodes WHERE id = ?', nodeId),
      statement('SELECT * FROM knowledge_edges WHERE from_node_id = ? ORDER BY created_at, id', nodeId),
      statement('SELECT * FROM knowledge_edges WHERE to_node_id = ? ORDER BY created_at, id', nodeId),
    ]);
    const node = decodeNode(first(rows));
    if (!node) return null;
    return { ...node, edgesFrom: edgesFrom.map(decodeEdge), edgesTo: edgesTo.map(decodeEdge) };
  }

  async function findKnowledge(query) {
    const options = typeof query === 'string' ? { text: query } : (query ?? {});
    const text = requiredText(options.text ?? options.query, 'query', 10_000);
    const limit = Math.min(maxLimit, Math.max(1, Number.isSafeInteger(options.limit) ? options.limit : defaultLimit));
    const type = options.nodeType ?? options.type ?? null;
    if (type !== null && !nodeTypes.has(type)) throw new Error(`Unknown knowledge node type: ${type}.`);
    const caseId = options.caseId ?? null;
    if (caseId !== null) optionalId(caseId, 'caseId');
    const researchOnly = options.researchOnly === true ? 1 : 0;
    const [rows] = await batch([statement(`
      SELECT * FROM knowledge_nodes
      WHERE vector_version = ? AND (? IS NULL OR node_type = ?)
        AND (? IS NULL OR case_id = ?)
        AND (? = 0 OR json_type(metadata_json, '$.researchLead') = 'true')
      ORDER BY updated_at DESC, id
      LIMIT 1000
    `, vectorVersion, type, type, caseId, caseId, researchOnly)]);
    const vector = lexicalVector(text);
    return rows.map(decodeNode)
      .map((node) => ({ ...node, score: cosine(vector, node.vector), matchMethod: 'hashed-lexical-cosine', vectorVersion: node.vectorVersion }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  return { putKnowledgeNode, linkKnowledgeNodes, findKnowledge, knowledgeNode };
}

export { vectorDimension, vectorVersion };
