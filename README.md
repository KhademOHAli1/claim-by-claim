# Claim by Claim

An interactive review of a submitted video about Ilhan Omar. The site connects playback and a timecoded transcript to 47 scoped assessments and 40 source records. The review reflects the evidence inspected through November 12, 2026. The transcript is provisional.

Read the [methodology](docs/methodology.md) and browse the [evidence register](evidence/registry.json) and [retained documents](evidence/README.md).

## Run locally

Use the Node version in [`.nvmrc`](.nvmrc) and install from the npm lockfile.

```sh
nvm use
npm ci
npm run dev
```

Open [the local site](http://127.0.0.1:5173/). Run `npm run check:content` to validate the public review data, captions, and evidence preview manifest.

Drag a pane by its title to move it. Drag the divider between panes to resize them. The site saves the layout in your browser. Open **Method → Reset layout** to restore the original arrangement.

## Build and deploy

Next.js exports the site to `out/`. The Cloudflare package includes a Worker that serves video byte ranges for seeking and playback.

```sh
npm run build
npm run deploy:prepare
npm run deploy:check
```

Authenticate the Cloudflare CLI with `npx cf auth login` and run `npm run deploy` to publish the prepared build. See the [deployment guide](DEPLOYMENT.md) for authentication, configuration, and post-deployment verification.

## Corrections

Use **Did we make a mistake?** in the Fact Check panel to open an issue with the selected claim and timestamp or start a pull request. Describe the proposed change and include supporting public evidence. Issues are public. Omit personal information and private documents. [Open the correction form](https://github.com/KhademOHAli1/claim-by-claim/issues/new?template=correction.yml) · [Compare changes for a pull request](https://github.com/KhademOHAli1/claim-by-claim/compare).

## License

The project's software code is licensed under [MIT](LICENSE). The review content, original sources, source excerpts, and submitted video remain subject to their respective rights and terms.
