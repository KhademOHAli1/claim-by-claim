export type Verdict =
  | 'Supported'
  | 'Contradicted'
  | 'Misleading'
  | 'Mixed'
  | 'Unsubstantiated'
  | 'Unresolved'
  | 'Not fact-checkable';

/** Colour is a navigation aid. The precise verdict must remain visible. */
export type VerdictStatus = 'green' | 'red' | 'orange' | 'neutral';
export type Confidence = 'High' | 'Medium' | 'Low';

export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}

export interface EvidencePreview {
  kind: 'image' | 'metadata';
  /** Local, public asset path. Never a local workstation path. */
  src?: string;
  label: string;
  caption: string;
  page?: string;
}

export interface CaseSource {
  id: string;
  evidenceId: string;
  title: string;
  type: string;
  url: string;
  published: string;
  pinpoint: string;
  originGroup: string;
  establishes: string;
  limits: string;
  inspected: boolean;
  preview: EvidencePreview;
  /** Restriction for short licensed reporting summaries, where applicable. */
  usageLimitWords?: number;
}

export interface Claim {
  id: string;
  start: number;
  end: number;
  quote: string;
  category: string;
  scope: string;
  verdict: Verdict;
  status: VerdictStatus;
  confidence: Confidence;
  confidenceReason: string;
  finding: string;
  counterevidence: string;
  unresolved: string;
  nextTest: string;
  sourceIds: string[];
  evidenceIds: string[];
  originGroups: string[];
  relations: {
    supporting: string[];
    contradicting: string[];
    context: string[];
  };
  reviewStatus: string;
}

export interface CaseData {
  schemaVersion: 1;
  id: string;
  title: string;
  asOf: string;
  reviewStatus: string;
  scopeNotes: string[];
  video: {
    src: string;
    poster: string;
    captions: string;
    durationSeconds: number;
  };
  transcript: {
    language: string;
    provisional: boolean;
    note: string;
    segments: TranscriptSegment[];
  };
  /** Includes retained evidence with metadata-only previews. */
  evidenceIds: string[];
  claims: Claim[];
  sources: CaseSource[];
}
