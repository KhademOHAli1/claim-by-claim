# Backend deployment

The operator API runs in a separate Cloudflare Worker with an EU D1 binding. D1 stores cases, the job queue, transcript revisions, approvals, and private findings. The runner uses FFmpeg and Whisper to transcribe audio, then calls Codex with the Investigate & Fact-Check skill after an operator approves the transcript. The public website serves its reviewed static export.

| Component | Where it runs | Cost control |
| --- | --- | --- |
| Operator API and database | Cloudflare Workers and the existing EU D1 database | Start within the free allowances. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Transcription | The existing Mac with MLX Whisper, or a Linux host with faster-whisper on CPU | Local inference with a cached model. The intake limit is 100 MiB and ten minutes. |
| Research | Codex on the runner, signed into ChatGPT by default | One active job, eight claims per run, and 20 starts per UTC month by default. Each failed research retry requires an operator action and counts as a new start. [Codex authentication](https://developers.openai.com/codex/auth) |

## Deploy the operator API

From the `site` directory, install the pinned dependencies using Bun and use Node 22 or newer for the Cloudflare CLI. Apply the migrations in `db/migrations` to the intended EU D1 database before deploying. The deployment requires Cloudflare access to create or update the Worker and bind D1.

```sh
bun install --frozen-lockfile
bun run test:backend
bun run backend:check
./node_modules/.bin/cf auth create claim-by-claim-backend-deploy --no-browser --no-device \
  --scopes account:read workers:write d1:write
CLAIM_BY_CLAIM_DEPLOY_PROFILE=claim-by-claim-backend-deploy bun run backend:deploy
bun run backend:status
```

Open the consent URL in Chrome on the Mac running the command and wait for the CLI to confirm sign-in. The Cloudflare CLI beta may return HTTP 403 at the deployment-history preflight even when script upload is authorized. With a scoped token supplied through `CLOUDFLARE_API_TOKEN`, run `bun backend/deploy.mjs --deploy-api` to upload through the Workers API and enable the operator endpoint. [Cloudflare CLI sign-in](https://developers.cloudflare.com/cf/get-started/#sign-in) · [Cloudflare upload API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)

The deploy command creates a random operator token once and stores it in `~/.config/claim-by-claim/operator-secret.json` with owner-only permissions. Cloudflare receives it as a Worker secret. Keep it out of frontend code, Git, and command output. `backend:status` checks that an anonymous request receives 401 and an authenticated request can read the live D1 counts. The deployment keeps Worker version URLs disabled.

The API accepts direct public HTTPS MP4, MOV and M4V URLs and supported public mastodon.social video posts. Files on the intake Mac use the CLI. Send the operator token as a Bearer token with every API request.

| Method and path | Operation |
| --- | --- |
| `POST /v1/cases` | Submit `{ "title": "...", "sourceUrl": "https://.../clip.mp4", "originalPostUrl": "https://.../post/123" }`. The original post field is optional for direct media. |
| `GET /v1/status` | Read case, job, and monthly research counts |
| `GET /v1/cases/{id}` | Read one case and its workflow state |
| `GET /v1/cases/{id}/transcript` | Retrieve the machine transcript for review |
| `GET /v1/cases/{id}/media` | Read capture provenance, frame leads and recorded engagement observations |
| `POST /v1/cases/{id}/engagement` | Save a manual snapshot with `{ "reviewer": "...", "observation": <engagement JSON> }`. See the [workflow guide](agentic-workflow.md) for the observation fields. |
| `POST /v1/cases/{id}/observations` | Save `{ "timestampSeconds": 12.5, "observation": "..." }` during transcript review |
| `POST /v1/cases/{id}/approve` | Submit `{ "review": <edited transcript>, "reviewer": "..." }` and queue research |
| `GET /v1/cases/{id}/draft` | Retrieve private draft findings |
| `POST /v1/cases/{id}/retry` | Retry a failed job with `{ "kind": "transcribe" }` or `{ "kind": "research" }` |

For a browser-based editorial dashboard, put the API behind an identity layer such as Cloudflare Access and authorize editors by identity. The current API is for trusted operator clients with a single token.

## Run the model jobs on the Mac

This is the lowest incremental cost deployment. The existing macOS service polls D1 while the Mac is awake and the user session is active. A newly submitted API job joins the same queue as a CLI submission. See the [case workflow guide](case-workflow.md) for service and transcript review commands.

## Move the runner to an always-on Linux host

Use a single Linux VM with Docker, a CPU-only Whisper model, and outbound HTTPS. Start with one runner and benchmark a representative video before sizing up. Keep the Mac runner available for any queued videos staged on the Mac. The Linux container accepts only remote video references so it does not consume those local jobs.

1. Copy [runner.env.example](../backend/runner.env.example) outside the checkout, set file mode `0600`, and provide a Cloudflare API token restricted to D1 Write for the account. The API Worker uses its D1 binding separately.
2. Place the installed Investigate & Fact-Check skill in a private directory. Provision the pinned multilingual [faster-whisper-small model](https://huggingface.co/Systran/faster-whisper-small/tree/536b0662742c02347bc0e980a01041f333bce120) in a separate directory. Include `config.json`, `model.bin`, `tokenizer.json`, and `vocabulary.json` or `vocabulary.txt`. These mounts must be readable by container user 10001. The worker loads its model offline.
3. Build the image and initialize the volumes. Use a fresh Codex device login for this host. [Headless Codex sign-in](https://developers.openai.com/codex/auth#login-on-headless-devices)

```sh
docker build -f backend/Dockerfile -t claim-by-claim-runner .
docker run --rm --user 0:0 \
  -v claim-data:/var/lib/claim-by-claim \
  -v claim-codex:/home/runner/.codex \
  --entrypoint install claim-by-claim-runner \
  -d -m 0700 -o 10001 -g 10001 /var/lib/claim-by-claim /home/runner/.codex
docker run --rm -it -v claim-codex:/home/runner/.codex \
  --entrypoint codex claim-by-claim-runner login --device-auth
```

4. Run a preflight with the same environment and mounts. Replace the example paths with absolute paths on the host.

```sh
docker run --rm --init --env-file /secure/runner.env \
  -v claim-data:/var/lib/claim-by-claim \
  -v claim-codex:/home/runner/.codex \
  --mount type=bind,src=/secure/models/whisper,dst=/models/whisper,readonly \
  --mount type=bind,src=/secure/investigate-and-fact-check,dst=/opt/investigate-and-fact-check,readonly \
  claim-by-claim-runner bun db/runner.mjs --check
```

5. Test a short synthetic clip on the host through transcription, transcript approval, and a private Codex draft. After that passes, use the same environment and mounts with `-d --name claim-by-claim-runner --restart unless-stopped` in place of `--rm`. Omit the command after the image name to start the watcher. Check `docker logs claim-by-claim-runner` and the D1 job status.

The default research path uses the ChatGPT login. To deliberately use metered API billing, set `CLAIM_RESEARCH_AUTH=api`, specify `CLAIM_RESEARCH_MODEL`, and set `OPENAI_API_KEY` in the protected environment. Apply a provider budget before that cutover. Confirm source access and tool compatibility with the chosen model during the host smoke test.
