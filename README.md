# Claim by Claim

[Open the production site](https://claim-by-claim.khademohali.me/).

An interactive review of a submitted video about Ilhan Omar. The site connects playback and a timecoded transcript to 47 scoped assessments and 40 source records. The review reflects the evidence inspected through November 12, 2026. The transcript is provisional.

Read the [methodology](docs/methodology.md) and browse the [evidence register](evidence/registry.json) and [retained documents](evidence/README.md).

## Run locally

Use the Bun version pinned in [`package.json`](package.json) and install from [`bun.lock`](bun.lock).

```sh
bun install --frozen-lockfile
bun run dev
```

Open [the local site](http://127.0.0.1:5173/). Run `bun run check:content` to validate the public review data, captions, and evidence preview manifest.

The editorial CLI submits cases to D1, exports transcripts for review, and retrieves Codex drafts. See the [agentic workflow guide](docs/agentic-workflow.md) for video intake, model routing, engagement and the knowledge graph, the [research tool review](docs/research-tool-review.md) for repository findings, and the [deployment guide](docs/backend-deployment.md) for the private API and Linux runner.

Drag a pane by its title to move it. Drag the divider between panes to resize them. The site saves the layout in your browser. Open **Method → Reset layout** to restore the original arrangement.

## Build and deploy

Use `bun run build:pages` to export the site to `out/` for Cloudflare Pages. The export includes a Worker that serves video byte ranges for seeking and playback.

```sh
bun run build
bun run deploy:prepare
bun run deploy:check
```

These commands prepare the standalone Cloudflare Worker. See the [deployment guide](DEPLOYMENT.md) for Pages settings, standalone Workers deployment and verification.

## Corrections

Use **Did we make a mistake?** in the Fact Check panel to open an issue with the selected claim and timestamp or start a pull request. Describe the proposed change and include supporting public evidence. Issues are public. Omit personal information and private documents. [Open the correction form](https://github.com/KhademOHAli1/claim-by-claim/issues/new?template=correction.yml) · [Compare changes for a pull request](https://github.com/KhademOHAli1/claim-by-claim/compare).

## License

The project's software code is licensed under [MIT](LICENSE). The review content, original sources, source excerpts, and submitted video remain subject to their respective rights and terms.
