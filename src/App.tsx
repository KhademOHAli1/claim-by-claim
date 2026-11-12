'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Code2,
  FileText,
  GitBranch,
  Link2,
  Maximize,
  Pause,
  Play,
  RotateCcw,
  Search,
  SkipBack,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge as ShadcnBadge } from '@/components/ui/badge';
import {
  Dialog as ShadcnDialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import Workspace from './components/Workspace';
import rawData from './data/case.json';
import type {
  CaseData,
  CaseSource,
  Claim,
  TranscriptWord,
  VerdictStatus,
} from './data/types';

const data = rawData as CaseData;
const repository = 'https://github.com/KhademOHAli1/claim-by-claim';
const sourcesById = new Map(data.sources.map((source) => [source.id, source]));
const titles: Record<string, string> = {
  C001: 'Are these all federal findings?',
  C002: 'A claim of political neutrality',
  C003: 'Her citizenship status',
  C004: 'Has she ever been a U.S. citizen?',
  C005: 'The birth-certificate allegation',
  C006: 'Two different dates, two different ages',
  C007: 'When did she arrive?',
  C008: 'Was her entry unlawful?',
  C009: 'Resettlement with her family',
  C010: 'The allegation about her father',
  C011: 'An individual death-toll allegation',
  C012: 'Citizenship and the minor requirement',
  C013: 'Does this mean prison for life?',
  C014: 'The biological-sibling allegation',
  C015: 'The alleged green-card purpose',
  C016: 'The family-relationship allegation',
  C017: 'An inquiry is documented',
  C018: 'The trafficking allegation',
  C019: 'Would every law be overturned?',
  C020: 'A prediction about future lawsuits',
  C021: 'What the tax records establish',
  C022: 'The alleged public-money transfers',
  C023: 'The money-laundering allegation',
  C024: 'Where is the complete interview?',
  C025: 'Two homes does not mean ownership',
  C026: 'A reported spousal winery interest',
  C027: 'Allegations of winery fraud',
  C028: 'The empty-barrel allegation',
  C029: 'Public support for Tim Walz',
  C030: 'The 2024 vice-presidential candidate',
  C031: 'Eligibility is not automatic issuance',
  C032: 'Are the licenses free?',
  C033: 'The knowledge-test requirement',
  C034: 'The road-test requirement',
  C035: 'Driver education depends on age',
  C036: 'Comparing adults and teenagers',
  C037: 'Licenses still have conditions',
  C038: 'An opinion, rather than a fact',
  C039: 'An undefined claim about motives',
  C040: 'What is behind the number 68?',
  C041: 'The fourteen-generation claim',
  C042: 'An ambiguous religious claim',
  C043: 'An unproven causal explanation',
  C044: 'Was a birth-certificate name changed?',
  C045: 'The alleged concealment motive',
  C046: 'A question about names',
  C047: 'The certificate-based fraud inference',
};
const toneNames: Record<VerdictStatus, string> = {
  green: 'Supported',
  red: 'Contradicted',
  orange: 'Context or uncertainty',
  neutral: 'Opinion / prediction',
};
const definitions = [
  ['Supported', 'The inspected evidence establishes the scoped claim.'],
  [
    'Contradicted',
    'Reliable evidence conflicts with the claim. This does not establish a deliberate lie.',
  ],
  [
    'Misleading',
    'Presentation or missing context creates a materially inaccurate impression.',
  ],
  ['Mixed', 'Different parts of the statement have different findings.'],
  [
    'Unsubstantiated',
    'The inspected evidence does not adequately establish the allegation. This does not mean it is false.',
  ],
  [
    'Unresolved',
    'Missing, inaccessible, conflicting or ambiguous evidence prevents a defensible conclusion.',
  ],
  [
    'Not fact-checkable',
    'Opinion, an undefined judgment, or a future prediction.',
  ],
];

export function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)
    .toString()
    .padStart(2, '0')}:${(safe % 60).toString().padStart(2, '0')}`;
}

function sourceKind(source: CaseSource) {
  if (/court docket/i.test(source.type)) return 'Court docket';
  if (/statut|constitutional/i.test(source.type)) return 'Legal text';
  if (/\.pdf(?:$|\?)/i.test(source.url)) return 'PDF document';
  if (/study|research|methodolog|scientific/i.test(source.type))
    return 'Research';
  if (/report|interview/i.test(source.type)) return 'Article';
  return 'Web record';
}

function Badge({ claim, small = false }: { claim: Claim; small?: boolean }) {
  return (
    <ShadcnBadge
      variant="outline"
      className={`verdict-badge tone-${claim.status} ${small ? 'small' : ''}`}
    >
      <span className="status-dot" />
      {claim.verdict}
    </ShadcnBadge>
  );
}

function ConfidenceSignal({ claim }: { claim: Claim }) {
  const level = { Low: 1, Medium: 2, High: 3 }[claim.confidence];
  const tone =
    claim.verdict === 'Unsubstantiated' || claim.verdict === 'Unresolved'
      ? 'red'
      : claim.status;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          className={`confidence-signal signal-${tone}`}
          aria-label={`${claim.confidence} confidence in the ${claim.verdict.toLowerCase()} assessment`}
        >
          {[1, 2, 3].map((bar) => (
            <span key={bar} aria-hidden="true" data-filled={bar <= level} />
          ))}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="signal-tooltip">
        <strong>{claim.confidence} confidence in this assessment</strong>
        <p>{claim.confidenceReason}</p>
      </TooltipContent>
    </Tooltip>
  );
}

type Cue = {
  id: string;
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
  claims: Claim[];
};
function createCues(): Cue[] {
  const cues: Cue[] = [];
  data.transcript.segments.forEach((segment) => {
    let group: TranscriptWord[] = [];
    function finish() {
      if (!group.length) return;
      const start = group[0].start,
        end = group[group.length - 1].end;
      const claims = data.claims.filter(
        (claim) =>
          Math.min(end, claim.end) - Math.max(start, claim.start) > 0.15,
      );
      cues.push({
        id: `cue-${cues.length}`,
        start,
        end,
        text: group.map((word) => word.text).join(' '),
        words: group,
        claims,
      });
      group = [];
    }
    segment.words
      .filter((word) => word.text.trim())
      .forEach((word) => {
        group.push(word);
        if (/[.!?]$/.test(word.text) || group.length >= 37) finish();
      });
    finish();
  });
  return cues;
}
const cues = createCues();

type Overlay =
  'method' | 'registry' | 'correction' | { source: CaseSource } | null;

function Dialog({
  overlay,
  close,
  openSource,
  claim,
  correctionUrl,
}: {
  overlay: Overlay;
  close: () => void;
  openSource: (source: CaseSource) => void;
  claim: Claim;
  correctionUrl: string;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('All types');
  const source = typeof overlay === 'object' && overlay ? overlay.source : null;
  const results = data.sources.filter(
    (item) =>
      `${item.id} ${item.evidenceId} ${item.title} ${item.type} ${item.url}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (kind === 'All types' || sourceKind(item) === kind),
  );
  const title =
    source?.title ??
    (overlay === 'registry'
      ? 'Sources'
      : overlay === 'correction'
        ? 'Did we make a mistake?'
        : 'How this review works');
  return (
    <ShadcnDialog
      open={!!overlay}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={`modal ${overlay === 'correction' ? 'correction-modal' : ''}`}
      >
        <div className="modal-top">
          <DialogTitle>{title}</DialogTitle>
          <Button
            variant="ghost"
            className="icon-button"
            onClick={close}
            aria-label="Close dialog"
          >
            <X size={18} />
          </Button>
        </div>
        <DialogDescription className="sr-only">
          {overlay === 'correction'
            ? 'Report a mistake or propose a correction on GitHub.'
            : 'Inspect sources, evidence limitations, and the method behind this fact check.'}
        </DialogDescription>
        {source ? (
          <>
            <div className="source-byline">
              {new URL(source.url).hostname.replace(/^www\./, '')}{' '}
              <span>·</span> {source.published}
            </div>
            {source.preview.kind === 'image' && source.preview.src ? (
              <figure className="document-preview">
                <img src={source.preview.src} alt={source.preview.caption} />
                <figcaption>{source.preview.caption}</figcaption>
              </figure>
            ) : (
              <div className="metadata-preview">
                <FileText size={30} />
                <span className="eyebrow">Source record preview</span>
                <h3>{source.title}</h3>
                <p>{source.preview.caption}</p>
                <p className="muted">
                  This is a source description, not a reproduction of the full
                  page. Open the original to inspect its complete context.
                </p>
              </div>
            )}
            <div className="source-detail-grid">
              <div>
                <span className="eyebrow">Where to look</span>
                <p>{source.pinpoint}</p>
              </div>
              <div>
                <span className="eyebrow">Source type</span>
                <p>{source.type}</p>
              </div>
            </div>
            <div className="source-explainer">
              <h3>What this source establishes</h3>
              <p>{source.establishes}</p>
              <h3>Limits to keep in view</h3>
              <p>{source.limits}</p>
              <p className="muted">
                Evidence {source.evidenceId} · Origin group {source.originGroup}
                . Sources sharing an origin are not independent corroboration.
              </p>
            </div>
            <div className="source-actions">
              <a
                className="primary-button"
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open original source <ArrowUpRight size={17} />
              </a>
              <a
                className="text-link"
                href={`${repository}/blob/main/${['S013', 'S015', 'S016', 'S017', 'S018'].includes(source.id) ? `evidence/originals/${source.evidenceId}.pdf` : source.preview.src ? `public${source.preview.src}` : 'evidence/registry.json'}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <GitBranch size={13} />
                {['S013', 'S015', 'S016', 'S017', 'S018'].includes(source.id)
                  ? 'Versioned document copy'
                  : source.preview.src
                    ? 'Versioned preview file'
                    : 'Versioned source record'}
                <ArrowUpRight size={13} />
              </a>
            </div>
          </>
        ) : overlay === 'registry' ? (
          <>
            <div className="registry-tools">
              <label className="search-field">
                <Search size={17} />
                <Input
                  autoComplete="off"
                  aria-label="Search evidence"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search by title, source or ID"
                />
              </label>
              <select
                aria-label="Filter source type"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                {[
                  'All types',
                  'Article',
                  'PDF document',
                  'Court docket',
                  'Legal text',
                  'Research',
                  'Web record',
                ].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </div>
            <p className="result-count">
              {results.length} of {data.sources.length} source records
            </p>
            <div className="registry-list">
              {results.map((item) => (
                <Button
                  variant="ghost"
                  key={item.id}
                  className="registry-row"
                  onClick={() => openSource(item)}
                >
                  <span className="source-icon">
                    <FileText size={19} />
                  </span>
                  <span>
                    <span className="source-meta">
                      {item.id} · {sourceKind(item)}
                    </span>
                    <strong>{item.title}</strong>
                    <span className="muted">
                      {new URL(item.url).hostname.replace(/^www\./, '')}
                    </span>
                  </span>
                  <ArrowUpRight size={18} />
                </Button>
              ))}
              {!results.length && (
                <div className="empty-state">
                  No sources match. Try a title, type, or source ID.
                </div>
              )}
            </div>
          </>
        ) : overlay === 'correction' ? (
          <>
            <p className="correction-claim">
              <strong>
                {claim.id} · {formatTime(claim.start)}
              </strong>{' '}
              {titles[claim.id]}
            </p>
            <div className="correction-options">
              <p>
                Describe what should change and link to the relevant evidence.
                The issue form already includes this claim and timestamp.
              </p>
              <a
                className="primary-button"
                href={correctionUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open an issue <ArrowUpRight size={15} />
              </a>
              <p>
                Have an edit ready? Push it to a branch, then compare that
                branch with main. If you used a fork, choose Compare across
                forks.
              </p>
              <a
                className="text-link"
                href={`${repository}/compare`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Start a pull request <ArrowUpRight size={13} />
              </a>
            </div>
          </>
        ) : (
          <>
            <p>
              <strong>Fact-checking methodology.</strong> We used GPT‑6.1 in
              ChatGPT with the open-source{' '}
              <a
                className="text-link"
                href="https://github.com/KhademOHAli1/investigate-and-fact-check"
                target="_blank"
                rel="noopener noreferrer"
              >
                Investigate &amp; Fact-Check skill
              </a>{' '}
              to identify checkable claims, trace them to original sources, and
              flag where the evidence was incomplete or conflicting.
            </p>
            <p className="modal-intro">
              This review examines 47 statements in the supplied video, as of 12
              November 2026.
            </p>
            <p>
              The signal bars show confidence in the assessment. Green means
              supported, red means contradicted or without enough evidence, and
              amber indicates a qualified finding. Read the verdict label to
              distinguish these outcomes.
            </p>
            <div className="definition-list">
              {definitions.map(([title, definition]) => (
                <div key={title}>
                  <strong>{title}</strong>
                  <p>{definition}</p>
                </div>
              ))}
            </div>
            <h3>A few important distinctions</h3>
            <p>
              Confidence describes confidence in the scoped assessment, not a
              probability of guilt or innocence. The 47 entries include
              overlapping statements, opinions and predictions; their counts are
              not a truth percentage.
            </p>
            <p>
              We distinguish an official finding from an allegation, an inquiry,
              a reported event, and an inference. We preserve counterevidence
              and source dependencies. Repeated articles about the same document
              are one evidence stream.
            </p>
            <p>
              The submitted video's original post and recording date are
              unverified. Its transcript was corrected using two automated
              recognition passes and has not had a complete listening review.
              Times are approximate. Ratings apply to the inspected evidence,
              not to an assumed date of recording or the speaker's intent.
            </p>
            <p>
              Some underlying records are private, sealed or inaccessible. Each
              finding identifies its limits and the next evidence that could
              change it. Public denials are retained where located. No reply
              request was sent; this is a desk review, not human editorial
              sign-off or legal clearance.
            </p>
            <a
              className="text-link"
              href={`${repository}/blob/main/docs/methodology.md`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Read the method and contribute <ArrowUpRight size={15} />
            </a>
          </>
        )}
      </DialogContent>
    </ShadcnDialog>
  );
}

export default function App() {
  const video = useRef<HTMLVideoElement>(null);
  const seekBar = useRef<HTMLInputElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const manualClaim = useRef<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedId, setSelectedId] = useState(data.claims[0].id);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [following, setFollowing] = useState(true);
  const [mode, setMode] = useState<'transcript' | 'claims'>('transcript');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [copied, setCopied] = useState(false);
  const [videoError, setVideoError] = useState('');
  const [resetToken, setResetToken] = useState(0);
  useEffect(() => {
    seekBar.current?.style.setProperty(
      '--progress',
      `${(currentTime / data.video.durationSeconds) * 100}%`,
    );
  }, [currentTime]);
  const selected =
    data.claims.find((claim) => claim.id === selectedId) ?? data.claims[0];
  const index = data.claims.findIndex((claim) => claim.id === selected.id);
  const activeCue = cues.find(
    (cue) => currentTime >= cue.start - 0.04 && currentTime < cue.end + 0.08,
  );
  const activeSources = selected.sourceIds
    .map((id) => sourcesById.get(id))
    .filter((source): source is CaseSource => !!source);
  const counts = useMemo(
    () =>
      data.claims.reduce(
        (all, claim) => ({ ...all, [claim.status]: all[claim.status] + 1 }),
        { green: 0, orange: 0, red: 0, neutral: 0 },
      ),
    [],
  );

  function seek(time: number, claim?: Claim) {
    if (video.current)
      video.current.currentTime = Math.min(time, data.video.durationSeconds);
    setCurrentTime(time);
    if (claim) {
      setSelectedId(claim.id);
      manualClaim.current = claim.id;
    } else manualClaim.current = null;
  }
  function selectClaim(claim: Claim) {
    seek(claim.start, claim);
    window.history.replaceState(null, '', `#${claim.id}`);
  }
  function synchronize(time: number) {
    setCurrentTime(time);
    const manual = data.claims.find(
      (claim) => claim.id === manualClaim.current,
    );
    if (manual && time >= manual.start - 0.15 && time <= manual.end) return;
    manualClaim.current = null;
    const candidate = data.claims
      .filter((claim) => time >= claim.start && time < claim.end)
      .sort(
        (a, b) => b.start - a.start || a.end - a.start - (b.end - b.start),
      )[0];
    if (candidate) setSelectedId(candidate.id);
  }
  async function togglePlay() {
    if (!video.current) return;
    if (video.current.paused) {
      try {
        await video.current.play();
        setVideoError('');
      } catch {
        setVideoError(
          'Playback could not start. Try again or reload the page.',
        );
      }
    } else video.current.pause();
  }
  useEffect(() => {
    const hash = () => {
      const target = data.claims.find(
        (claim) => `#${claim.id}` === window.location.hash,
      );
      if (target) selectClaim(target);
    };
    window.addEventListener('hashchange', hash);
    hash();
    return () => window.removeEventListener('hashchange', hash);
  }, []);
  useEffect(() => {
    if (!following || !transcript.current) return;
    const id = mode === 'claims' ? selectedId : activeCue?.id;
    const row = id
      ? transcript.current.querySelector<HTMLElement>(`[data-row="${id}"]`)
      : null;
    if (row) {
      const parent = transcript.current;
      const rect = row.getBoundingClientRect(),
        bounds = parent.getBoundingClientRect();
      if (rect.top < bounds.top + 15 || rect.bottom > bounds.bottom - 15)
        parent.scrollTo({
          top:
            parent.scrollTop +
            rect.top -
            bounds.top -
            parent.clientHeight * 0.28,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)')
            .matches
            ? 'instant'
            : 'smooth',
        });
    }
  }, [selectedId, activeCue?.id, following, mode]);

  const matchingClaims = data.claims.filter(
    (claim) =>
      (filter === 'all' || claim.status === filter) &&
      `${claim.quote} ${claim.finding} ${claim.id}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const matchingCues = cues.filter((cue) =>
    cue.text.toLowerCase().includes(search.toLowerCase()),
  );
  async function copyLink() {
    const url = new URL(window.location.href);
    url.hash = selected.id;
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.history.replaceState(null, '', `#${selected.id}`);
      setCopied(false);
    }
  }
  const correctionQuery = new URLSearchParams({
    template: 'correction.yml',
    title: `[Correction] ${selected.id}: ${titles[selected.id]}`,
    claim: selected.id,
    timestamp: formatTime(selected.start),
  });
  const correctionUrl = `${repository}/issues/new?${correctionQuery}`;

  const panes = {
    video: (
      <section className="panel video-panel" aria-label="Source video">
        <div className="video-stage">
          <video
            ref={video}
            playsInline
            preload="metadata"
            poster={data.video.poster}
            muted={muted}
            onTimeUpdate={(event) =>
              synchronize(event.currentTarget.currentTime)
            }
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() =>
              setVideoError(
                'The video could not load. Please reload or check your connection.',
              )
            }
            onLoadedMetadata={() => {
              const claim = data.claims.find(
                (claim) => claim.id === window.location.hash.slice(1),
              );
              if (claim) seek(claim.start, claim);
            }}
            aria-label="Submitted video about Ilhan Omar"
          >
            <source src={data.video.src} type="video/mp4" />
            <track
              kind="captions"
              src={data.video.captions}
              srcLang="en"
              label="English (corrected automatic transcript)"
            />
          </video>
          <Button
            variant="ghost"
            className={`video-play-overlay ${playing ? 'is-playing' : ''}`}
            onClick={togglePlay}
            aria-label={playing ? 'Pause video' : 'Play video'}
          >
            {playing ? (
              <Pause size={26} fill="currentColor" />
            ) : (
              <Play size={26} fill="currentColor" />
            )}
          </Button>
        </div>
        <div className="video-controls">
          <div className="video-control-row">
            <Button
              variant="ghost"
              className="icon-button main-play"
              onClick={togglePlay}
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? (
                <Pause size={18} fill="currentColor" />
              ) : (
                <Play size={18} fill="currentColor" />
              )}
            </Button>
            <Button
              variant="ghost"
              className="icon-button"
              aria-label="Back 10 seconds"
              onClick={() => seek(Math.max(0, currentTime - 10))}
            >
              <SkipBack size={17} />
            </Button>
            <span className="time-readout">
              {formatTime(currentTime)} <span>/ 02:59</span>
            </span>
            <div className="control-spacer" />
            <Button
              variant="ghost"
              className="icon-button"
              aria-label={muted ? 'Unmute video' : 'Mute video'}
              onClick={() => setMuted(!muted)}
            >
              {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
            </Button>
            <Button
              variant="ghost"
              className="icon-button"
              aria-label="Full screen video"
              onClick={() => {
                if (video.current?.requestFullscreen)
                  void video.current
                    .requestFullscreen()
                    .catch(() =>
                      setVideoError(
                        'Full screen is unavailable in this browser.',
                      ),
                    );
              }}
            >
              <Maximize size={16} />
            </Button>
          </div>
          <input
            className="seek-bar"
            aria-label="Video position"
            type="range"
            min="0"
            max={data.video.durationSeconds}
            step="0.05"
            value={currentTime}
            ref={seekBar}
            onChange={(event) => seek(Number(event.target.value))}
          />
        </div>
        {videoError && (
          <p className="video-error" role="status">
            {videoError}
          </p>
        )}
      </section>
    ),
    transcript: (
      <section
        className="panel transcript-panel"
        aria-label="Transcript and claims"
      >
        <div className="transcript-toolbar">
          <Tabs
            value={mode}
            onValueChange={(value) => setMode(value as 'transcript' | 'claims')}
          >
            <TabsList className="tabs" aria-label="Transcript view">
              <TabsTrigger value="transcript">Transcript</TabsTrigger>
              <TabsTrigger value="claims">
                Claims <span>47</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="transcript-actions">
            <Button
              variant="ghost"
              className="icon-button"
              onClick={() => setSearchOpen(!searchOpen)}
              aria-label="Search transcript and claims"
              aria-expanded={searchOpen}
            >
              <Search size={15} />
            </Button>
            <Button
              variant="ghost"
              className={`follow-button ${following ? 'on' : ''}`}
              onClick={() => setFollowing(!following)}
              aria-pressed={following}
            >
              <span className="follow-dot" />
              {following ? 'Following' : 'Follow video'}
            </Button>
          </div>
        </div>
        {searchOpen && (
          <label className="search-field transcript-search">
            <Search size={15} />
            <Input
              aria-label="Search statements"
              placeholder="Find a word or claim…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        )}
        {mode === 'claims' && (
          <div className="claim-filters">
            <select
              aria-label="Filter claims by verdict color"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">All 47 assessments</option>
              {(['green', 'orange', 'red', 'neutral'] as VerdictStatus[]).map(
                (tone) => (
                  <option key={tone} value={tone}>
                    {toneNames[tone]} ({counts[tone]})
                  </option>
                ),
              )}
            </select>
            <span>{matchingClaims.length} shown</span>
          </div>
        )}
        <div
          className="transcript-scroll"
          ref={transcript}
          onWheel={() => setFollowing(false)}
          tabIndex={0}
          aria-label={
            mode === 'claims' ? 'Claim list' : 'Scrollable transcript'
          }
        >
          {mode === 'transcript'
            ? matchingCues.map((cue) => {
                const active = activeCue?.id === cue.id;
                const tones = new Set(cue.claims.map((claim) => claim.status));
                const tone =
                  tones.size === 1
                    ? [...tones][0]
                    : cue.claims.length
                      ? 'orange'
                      : 'neutral';
                const label =
                  cue.claims.length === 1
                    ? cue.claims[0].verdict
                    : cue.claims.length > 1
                      ? 'Multiple assessments'
                      : 'Transcript';
                return (
                  <div
                    key={cue.id}
                    data-row={cue.id}
                    className={`transcript-cue tone-${tone} ${active ? 'active' : ''}`}
                  >
                    <Button
                      variant="ghost"
                      className="cue-main"
                      onClick={() => {
                        const claim = cue.claims[0];
                        seek(cue.start, claim);
                        if (claim)
                          window.history.replaceState(null, '', `#${claim.id}`);
                      }}
                      aria-label={`${formatTime(cue.start)}. ${cue.text}. ${label}`}
                    >
                      <span className="cue-time">
                        {active ? (
                          <span className="playing-bars">
                            <i />
                            <i />
                            <i />
                          </span>
                        ) : (
                          formatTime(cue.start)
                        )}
                      </span>
                      <span className="cue-text">
                        {cue.words.map((word, wordIndex) => (
                          <span
                            className={
                              active &&
                              currentTime >= word.start &&
                              currentTime < word.end
                                ? 'spoken-word'
                                : ''
                            }
                            key={wordIndex}
                          >
                            {word.text}{' '}
                          </span>
                        ))}
                      </span>
                    </Button>
                  </div>
                );
              })
            : matchingClaims.map((claim) => (
                <Button
                  variant="ghost"
                  key={claim.id}
                  data-row={claim.id}
                  className={`claim-list-row ${selected.id === claim.id ? 'active' : ''}`}
                  onClick={() => selectClaim(claim)}
                >
                  <div>
                    <span className="cue-time">{formatTime(claim.start)}</span>
                    <span className="claim-id">{claim.id}</span>
                  </div>
                  <strong>{titles[claim.id]}</strong>
                  <span className="claim-quote">“{claim.quote}”</span>
                  <Badge claim={claim} small />
                </Button>
              ))}
          {(mode === 'claims'
            ? !matchingClaims.length
            : !matchingCues.length) && (
            <p className="empty-state">
              No matching statements. Try another search or filter.
            </p>
          )}
        </div>
      </section>
    ),
    finding: (
      <section
        className="panel finding-panel"
        aria-label="Selected claim fact check"
      >
        <div className="claim-tools">
          <span className="claim-position">Claim {index + 1} of 47</span>
          <Button
            variant="ghost"
            className="icon-button"
            disabled={index === 0}
            aria-label="Previous claim"
            onClick={() => selectClaim(data.claims[index - 1])}
          >
            <ChevronLeft size={17} />
          </Button>
          <Button
            variant="ghost"
            className="icon-button"
            disabled={index === data.claims.length - 1}
            aria-label="Next claim"
            onClick={() => selectClaim(data.claims[index + 1])}
          >
            <ChevronRight size={17} />
          </Button>
          <span className="control-spacer" />
          <Button
            variant="ghost"
            className="claim-time"
            onClick={() => selectClaim(selected)}
          >
            {formatTime(selected.start)}
          </Button>
          <Button
            variant="ghost"
            className="icon-button"
            aria-label={copied ? 'Claim link copied' : 'Copy link to claim'}
            onClick={copyLink}
          >
            {copied ? <Check size={14} /> : <Link2 size={14} />}
          </Button>
        </div>
        <div className="finding-scroll" key={selected.id}>
          <div className="finding-meta">
            <Badge claim={selected} />
            <ConfidenceSignal claim={selected} />
          </div>
          <h2>{titles[selected.id]}</h2>
          <p className="finding-summary">{selected.finding}</p>
          <div className="finding-scope">
            <span className="eyebrow">What we assessed</span>
            <p>{selected.scope}</p>
          </div>
          <div className="finding-analysis-grid">
            <div>
              <span className="eyebrow">Basis of assessment</span>
              <p>{selected.confidenceReason}</p>
            </div>
            <div>
              <span className="eyebrow">Counterevidence & limits</span>
              <p>{selected.counterevidence}</p>
            </div>
          </div>
          <details className="finding-details">
            <summary>
              What evidence could change this finding?{' '}
              <ChevronRight size={15} />
            </summary>
            <div>
              <p>
                <strong>Open question:</strong> {selected.unresolved}
              </p>
              <p>
                <strong>Next decisive check:</strong> {selected.nextTest}
              </p>
            </div>
          </details>
        </div>
        <div className="finding-actions">
          <Button
            variant="outline"
            className="correction-trigger"
            aria-haspopup="dialog"
            onClick={() => setOverlay('correction')}
          >
            <GitBranch size={14} />
            Did we make a mistake?
          </Button>
        </div>
      </section>
    ),
    evidence: (
      <section
        className="panel evidence-panel"
        aria-label="Evidence for selected claim"
      >
        <div className="evidence-scroll">
          {activeSources.map((source) => (
            <Button
              variant="ghost"
              key={source.id}
              className="evidence-row"
              onClick={() => setOverlay({ source })}
            >
              <span
                className={`source-thumbnail ${source.preview.src ? 'has-image' : ''}`}
              >
                {source.preview.src ? (
                  <img src={source.preview.src} alt="" loading="lazy" />
                ) : (
                  <FileText size={21} />
                )}
              </span>
              <span className="evidence-row-content">
                <span className="source-meta">
                  {source.id}
                  <span>·</span>
                  {sourceKind(source)}
                </span>
                <strong>{source.title}</strong>
                <span className="source-location">{source.pinpoint}</span>
              </span>
              <span className="preview-arrow">
                <ArrowUpRight size={17} />
              </span>
            </Button>
          ))}
        </div>
      </section>
    ),
  };

  return (
    <TooltipProvider delayDuration={200}>
      <a className="skip-link" href="#explore">
        Skip to the fact check
      </a>
      <header className="site-header">
        <a
          className="brand"
          href="#"
          onClick={(event) => event.preventDefault()}
        >
          claim by claim<span className="brand-period">.</span>
        </a>
        <span className="case-context">Ilhan Omar video</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              className="overall-assessment"
              onClick={() => selectClaim(data.claims[0])}
            >
              <CircleAlert size={15} />
              <strong>Contains factual errors</strong>
              <ChevronRight size={13} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Some statements are supported. Other allegations remain unproven.
            Read each claim's assessment.
          </TooltipContent>
        </Tooltip>
        <nav aria-label="Main navigation">
          <Button variant="ghost" onClick={() => setOverlay('registry')}>
            <BookOpen size={14} /> Sources
          </Button>
          <Button variant="ghost" onClick={() => setOverlay('method')}>
            <CircleHelp size={14} /> Method
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                className="reset-layout"
                onClick={() => setResetToken((value) => value + 1)}
                aria-label="Reset layout"
              >
                <RotateCcw size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reset pane positions and sizes</TooltipContent>
          </Tooltip>
          <a
            className="github-button"
            href={repository}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View source code on GitHub"
          >
            <Code2 size={16} />
          </a>
        </nav>
      </header>
      <main id="explore" aria-label="Synchronized video fact check">
        <Workspace panes={panes} resetToken={resetToken} />
      </main>
      <footer className="site-footer">
        <span>
          Reviewed 12 Nov 2026 <span className="footer-separator">·</span>{' '}
          Unproven does not mean false.
        </span>
      </footer>
      <Dialog
        overlay={overlay}
        close={() => setOverlay(null)}
        openSource={(source) => setOverlay({ source })}
        claim={selected}
        correctionUrl={correctionUrl}
      />
    </TooltipProvider>
  );
}
