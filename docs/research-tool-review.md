# Research tool review

This review maps the projects named in the intake notes to Claim by Claim's current workflow. It records reusable design patterns and integration limits. The project remains an editorial system with a human publication decision. Downloaded media, transcripts, model outputs, and source captures are separate artifacts with their own timestamps and hashes.

## Patterns already used

The [Investigate & Fact-Check skill](https://github.com/KhademOHAli1/investigate-and-fact-check) supplies the evidence discipline for the workflow. It separates direct observations, attributed assertions, inferences, and unknowns. It requires original-source tracing, contrary evidence, source independence, provenance, and a final human review. The runner uses those rules when it passes an approved transcript to Codex.

[Meedan Check](https://github.com/meedan/check) is an MIT-licensed collaborative media-annotation platform. Its repository is a development environment and explicitly says not to use it in production. We use it as an editorial reference for claim annotations, source-linked review, and collaborative queues. The full application is deferred because it is a large multi-service system and would duplicate the existing Claim by Claim interface.

[Meedan Alegre](https://github.com/meedan/alegre) is an MIT-licensed Check service for text and media similarity. Its documented similarity infrastructure covers language, translation, text, audio, and video workloads. The current pilot uses its candidate-match pattern with a small local scorer in the research job. A reviewer can inspect the source, context, and independence before linking a match.

[Loki / OpenFactVerification](https://github.com/Libr-AI/OpenFactVerification) is MIT-licensed and documents a pipeline for claim decomposition, claim-worthiness assessment, query generation, evidence retrieval, crawling, and verification. It supports text, speech, image, and video inputs. Its stages give us a comparison target for Codex. The documented API-key and search dependencies would add cost and another service to the pilot.

[facticli](https://github.com/aic-factcheck/facticli) is an agentic CLI framework that describes stage contracts for claim extraction, research, review, and judging. It also documents per-stage model routing, run token budgets, deterministic source tiering, opposing-verdict review, citation health checks, and artifact audits. These are the routing and verification patterns used for the next Claim by Claim stages. The repository is a reference implementation rather than a runtime dependency.

[Bellingcat Auto Archiver](https://github.com/bellingcat/auto-archiver) and [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox) provide preservation patterns. Auto Archiver routes a URL through configured extractors and enrichers. ArchiveBox stores HTML, screenshots, PDFs, WARC, text, media, and metadata. The current media capture records the original URL, capture time, content hash, derivative hashes and method. A later archival step should preserve selected source bytes and locator context under case retention rules.

## Evaluation and deferred components

[OpenFactCheck](https://github.com/openfactcheck-research/openfactcheck) is an AGPL-3.0 factuality evaluation project. Its repository describes version two as under active development and exposes intermediate evaluation stages. It is useful for offline model and checker comparisons. It is deferred from the product runtime because its license and evolving API require a separate integration review.

[AVeriTeC](https://github.com/MichSchli/AVeriTeC) is a dataset and baseline for real-world claim verification with web evidence. Its records include claim text, verdict, justification, speaker, dates, original URLs, and evidence medium. The repository states a CC BY-NC 4.0 license. We use it for schema and regression evaluation only after confirming that a planned use fits that license.

[M4FC](https://github.com/UKPLab/M4FC) provides Apache-2.0 code and a CC-BY-SA-4.0 multimodal fact-checking dataset. The visual claim extraction and contextualization subsets are candidates for an offline benchmark. Linked articles and images retain their own rights.

[Media Cloud](https://github.com/mediacloud/backend) demonstrates source collections, story indexing, topic queries, and quantitative media analysis. The backend repository is AGPL-3.0 and marked read-only after archival in December 2023. Its README directs most users to the public API and tools. We defer self-hosting and may later add a narrowly scoped API adapter for discovery and time-series context.

[OpenAleph](https://github.com/openaleph/openaleph) is a possible future document and entity-search system. It is useful for large investigative collections and cross-referencing. It is deferred until the case volume justifies a separate document index and retention design. The current D1 schema is the authoritative editorial register.

[RSSHub](https://github.com/DIYgod/RSSHub) can normalize supported feeds. [Bluesky Jetstream](https://github.com/bluesky-social/jetstream) exposes a stream of public AT Protocol events. Use feed entries and stream events to discover candidate cases. A watchlist should persist its cursor and rate limit, then pass selected cases through normal intake.

[PySceneDetect](https://github.com/Breakthrough/PySceneDetect) could improve frame coverage for quick edits. [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) is a candidate for multilingual on-screen text once Tesseract has been measured on the pilot corpus. [C2PA Rust](https://github.com/contentauth/c2pa-rs) can report signed content credentials when present. Record a credential result as a provenance observation and verify the claim itself through evidence.

[Label Studio](https://github.com/HumanSignal/label-studio) is a possible tool for annotating evaluation fixtures. [Gephi](https://github.com/gephi/gephi) can visualize reviewed relationship exports when the corpus grows. The graph should retain the underlying observations and source links independently of the visualization.

## Knowledge and narrative model

The current graph stores explicit topic, claim, occurrence, narrative, entity, event, source and evidence nodes. Topics carry an editor-defined label and scope. An identified reviewer records relationships such as `supports`, `contradicts` and `same_claim_variant`, with a provenance field for the basis of the relationship. Similarity scores surface candidate records for review.

The first retrieval implementation uses a versioned hashed lexical vector and cosine similarity. Results are labeled as retrieval leads. A future PostgreSQL deployment could use [pgvector](https://github.com/pgvector/pgvector), which supports exact and approximate nearest-neighbor search alongside relational joins and transactions. The migration should happen only when D1 and the bounded local index no longer meet the workload.

## Media and impact signals

The pilot transcribes direct media URLs with FFmpeg and local Whisper tooling. It can add sampled-frame observations and OCR candidates as timestamped derivatives. Automated visual output is an observation or lead until a reviewer inspects the relevant frame.

Engagement observations record the method, source, time and available counts. Mastodon provides the first automatic snapshots for supported video posts. The optional YouTube lookup returns one point-in-time response outside the historical register. TikTok and Meta access depends on their respective programs. [Mastodon status API](https://docs.joinmastodon.org/methods/statuses/) · [YouTube `videos.list`](https://developers.google.com/youtube/v3/docs/videos/list) · [TikTok Research API](https://developers.tiktok.com/products/research-api/) · [Meta Content Library](https://transparency.meta.com/researchtools/meta-content-library/)

## Adoption gates

Before a new external component enters the runtime, record its license, version, source URL, credentials, network behavior, retention behavior, failure mode, and test fixture. Run it against an offline fixture first. The output must retain source identity and retrieval metadata, expose uncertainty, and leave publication behind the existing transcript and editorial review gates.
