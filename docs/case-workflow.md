# Case database and review workflow

Intake and the background runner use the private Cloudflare D1 database in the EU. The public site continues to serve a reviewed static export. New transcripts and research drafts are visible through the operator CLI.

## Submit and review a video

Run these commands from the site repository:

```sh
bun run db status
bun run db submit "Title of the video" "/absolute/path/to/video.mp4"
```

`submit` also accepts a direct public HTTPS video URL without query parameters or a supported mastodon.social video post. Use MP4, MOV or M4V for local uploads. The pilot handles files up to 100 MiB and clips up to ten minutes. A local submission copies the video into the private intake directory on this Mac and puts its content reference in D1. The runner downloads remote media when its job starts. Submitting the same reference and post returns the existing job. Approve a transcript for research only if its text and relevant observations can be sent to Codex. See the [agentic workflow guide](agentic-workflow.md) for frame analysis, engagement and graph commands.

Use the returned case ID to follow the submission. Once it reaches `needs_transcript_review`, export the transcript to a private path, check it against the video, and correct the segment text and timings. The approval records a separate revision and authorizes one Codex run on that revision and any recorded on-screen observations. Use `CLAIM_BY_CLAIM_REVIEWER` to set the reviewer name.

```sh
bun run db case CASE_ID
bun run db transcript CASE_ID .case-data/review.json
# Review and save .case-data/review.json before proceeding.
bun run db observe CASE_ID 42.5 "A document heading is visible on screen."
bun run db approve CASE_ID .case-data/review.json
bun run db draft CASE_ID
```

An editor should inspect the decisive sources and review the draft before publication. Preserve the original files and keep draft and review JSON out of Git. For a failed job, check `bun run db status`, resolve the listed problem, and run `bun run db retry CASE_ID transcribe` or `bun run db retry CASE_ID research`.

The original SQLite tools are available through `bun run db --local init` and `bun run db --local status`. Set `CLAIM_BY_CLAIM_DB` to select a different local file. Local submissions do not enter the shared runner queue.

## Run the worker on a Mac

The runner uses FFmpeg and a locally cached MLX Whisper model for audio transcription. It uses the existing ChatGPT sign-in for Codex. Run `bun run db:runner --check` to check the required tools and D1 access. Use `bun run db:runner --once` to process one queued job manually, or `bun run db:service install` to run a user LaunchAgent in the background. The service needs this Mac awake and the user session running. It checks D1 every two minutes while idle. Use `bun run db:service status` to inspect it and `bun run db:service remove` to stop and remove it. The service runs from a private copy under `~/Library/Application Support/Claim by Claim`, where it also stores logs and intake media. Remove and reinstall the service to load code changes.

Set `CLAIM_BY_CLAIM_WHISPER_PYTHON`, `CLAIM_BY_CLAIM_WHISPER_MODEL`, or `CLAIM_BY_CLAIM_FFMPEG` to override the local tool locations. `CLAIM_RESEARCH_CODEX` selects the Codex binary, and `CLAIM_RESEARCH_SKILL_DIR` selects the installed skill directory. The runner uses one job at a time and caps research at eight claims per run and 20 starts per UTC calendar month by default. Failed research requires an explicit retry and each start counts toward the limit. Set `CLAIM_RESEARCH_MAX_CLAIMS` or `CLAIM_RESEARCH_MONTHLY_LIMIT` lower for a cheaper pass. [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)

## Provision the shared database

Authorize a separate Cloudflare CLI profile for D1. The login prints a consent link. Open it in a browser on the Mac running the CLI so it can receive the localhost callback.

```sh
./node_modules/.bin/cf auth create claim-by-claim-d1 --no-browser --no-device --scopes account:read d1:write
./node_modules/.bin/cf d1 list --name claim-by-claim --profile claim-by-claim-d1
```

If that name is unused in the intended account, create it with EU jurisdiction:

```sh
./node_modules/.bin/cf d1 create --name claim-by-claim --jurisdiction eu --profile claim-by-claim-d1
```

Set `DB_ID` to the verified database UUID. Apply the schema and import the public seed. The seed can be run again without overwriting existing records.

```sh
./node_modules/.bin/cf d1 migrations apply "$DB_ID" --dir db/migrations --profile claim-by-claim-d1
db_seed_path="$(mktemp -t claim-by-claim-d1-seed)"
bun db/seed-public.mjs > "$db_seed_path" &&
  ./node_modules/.bin/cf d1 query "$DB_ID" --sql "@$db_seed_path" --profile claim-by-claim-d1
./node_modules/.bin/cf d1 query "$DB_ID" --profile claim-by-claim-d1 --sql \
  'SELECT (SELECT COUNT(*) FROM videos) AS videos, (SELECT COUNT(*) FROM claims) AS claims, (SELECT COUNT(*) FROM evidence) AS evidence; PRAGMA foreign_key_check;'
```

The project defaults point to the existing Claim by Claim database. Set `CLAIM_BY_CLAIM_D1_ID`, `CLAIM_BY_CLAIM_CF_ACCOUNT_ID` and `CLAIM_BY_CLAIM_CF_PROFILE` to target an authorized test database or a different installation. The initial import uses only the checked-in public case.

## Rollout

1. **Intake and transcription.** A single runner takes a lease on the next queued job. It extracts an audio derivative and stores a provisional timed transcript. It keeps the original file separate. D1 jurisdiction applies to database storage and query execution. [D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/)
2. **Transcript approval and research.** An editor checks decisive quotations, names and timecodes and can review sampled frame text. The runner passes the approved transcript, manual observations and bounded OCR leads to Codex with the installed Investigate & Fact-Check skill. It saves structured findings and a citation audit in the draft table. [Investigate & Fact-Check skill](https://github.com/KhademOHAli1/investigate-and-fact-check)
3. **Publication.** An editor checks decisive sources and records a publication decision. A future publication step can export approved fields and media references to the public site for review.

## Cost

| Component | Pilot choice |
| --- | --- |
| Metadata | Local SQLite has no hosting charge. D1 Free includes 5 million rows read and 100,000 rows written per day, with up to 500 MB per database. [Pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [Limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Media and evidence files | Use the existing storage for the pilot. Add private R2 Standard when shared uploads are needed. Its free allowance includes 10 GB-month of storage, 1 million Class A operations and 10 million Class B operations each month. [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Transcription and research | Start with existing tools and a single background runner. Measure the human review time and Codex usage on a real case before deciding how many jobs to automate. |
| Queueing | Start with the jobs table and one worker. Add a managed queue when immediate wakeups or parallel processing justify a separate service. |

When the database is hosted, keep the runner and editorial interface behind authenticated access. Keep credentials and unpublished material out of public Git history. If the pilot takes submissions from outside the editorial team, add authenticated upload, file validation, retention and access rules before opening that route.
