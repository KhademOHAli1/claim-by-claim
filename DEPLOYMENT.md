# Cloudflare deployment

The application uses React and the Next.js App Router with a static export. Next.js produces the application with its normal `next build`; a small Cloudflare Worker adds HTTP byte ranges for the video. Deployment uses the `cf` CLI and its prebuilt Build Output format.

## Build and validate

Use the Node version in `.nvmrc`, install from the npm lockfile, then build:

```sh
nvm use
npm ci
npm run build
node --test deploy/worker.test.mjs deploy/prepare.test.mjs
node deploy/prepare.mjs
npx cf deploy --prebuilt --dry-run
```

The Next.js configuration must use `output: 'export'`. Its build produces `out/`, including HTML, client JavaScript and public media. Server-only Next.js features are outside this deployment model. See [Next.js static exports](https://nextjs.org/docs/app/guides/static-exports).

`deploy/prepare.mjs` packages the existing export and compiles the standalone media Worker by stripping TypeScript types with Node. It has no Vite or framework-adapter requirement. It rejects missing exports, symlinks and assets larger than 25 MiB before replacing generated deployment output.

## Build Output layout

```text
.cloudflare/output/v0/
  config.json
  workers/default/
    worker.config.json
    bundle/worker.js
    assets/                 # copy of the Next.js out/ directory
```

The root configuration contains `buildContext: { "isPreview": false }`. If `CLOUDFLARE_ACCOUNT_ID` is supplied during preparation, it is also recorded in that generated configuration. Otherwise the authenticated CLI selects the account according to its normal rules.

The generated Worker configuration is:

```json
{
  "name": "claim-by-claim",
  "compatibilityDate": "2026-11-12",
  "env": { "ASSETS": { "type": "assets" } },
  "assets": {
    "htmlHandling": "auto-trailing-slash",
    "notFoundHandling": "404-page",
    "runWorkerFirst": ["/media/*"]
  },
  "manifest": {
    "type": "complete",
    "mainModule": "worker.js",
    "modules": { "worker.js": { "type": "esm" } }
  }
}
```

`cf deploy --prebuilt` consumes this tree without rebuilding or automatically reconfiguring the Next.js project. Use it without `--mode`, because this build records no mode. The positional command `cf deploy out` is for assets-only projects and would omit the media Worker.

The layout and schemas are checked against the installed cf toolchain. The artifact test invokes the actual CLI dry run and includes a negative control that must reject an invalid Worker configuration. Pin the CLI through the lockfile because Build Output v0 is a beta format. See [prebuilt deployment](https://developers.cloudflare.com/cf/projects/#deploy-a-prebuilt-build) and the [official Build Output utilities](https://github.com/cloudflare/workers-sdk/tree/main/packages/build-output-utils).

## Authenticate and deploy

Authenticate the CLI with browser OAuth:

```sh
npx cf auth login
npx cf deploy --prebuilt
```

For unattended deployment, supply a suitably scoped `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through the CI secret store. Credentials do not belong in source or generated assets. A connected Cloudflare application session is separate from local CLI authentication. See [cf authentication](https://developers.cloudflare.com/cf/get-started/) and [CI credentials](https://developers.cloudflare.com/cf/ci/).

An account Workers subdomain or a custom domain is required for public access. A Workers subdomain produces `https://claim-by-claim.<account-subdomain>.workers.dev/`. Report the actual URL only after deployment and verification.

## Video ranges

Workers Static Assets currently returns a full `200` response when given a `Range` request. Safari video playback can require byte-range support, so `/media/*` runs `deploy/worker.ts` first. Other paths use normal asset routing. See [Static Assets limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

The Worker streams a single closed, open-ended or suffix byte range. It returns `206` with exact `Content-Range` and `Content-Length`, cancels unread source data, and retains asset validators and cache policy. Invalid, multipart and unsatisfiable ranges receive `416`. `HEAD` returns full-resource metadata without a body. Normal conditional responses take precedence; `If-Range` requires a strong matching validator. Unknown-length or encoded representations fall back to full-file delivery.

The partial response uses [FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#fixedlengthstream), so Workers derives the correct length without buffering the video. Individual assets must remain within the [25 MiB file limit](https://developers.cloudflare.com/workers/platform/limits/). Media Worker invocations also use the applicable Workers request and CPU quotas.

## Verify the deployment

- Confirm the root page, exported routes, public evidence links and a missing-route `404` response.
- Check video `GET`, `HEAD`, `Range: bytes=0-1`, an open-ended range, a suffix range and an unsatisfiable range against the public URL.
- Confirm the partial byte count and `Content-Range` total match the deployed media file.
- Confirm seeking and final-second playback in Safari/WebKit on the deployed site.

Local tests and a CLI dry run validate packaged code and configuration. They do not establish that an authenticated deployment or public-browser check has succeeded.
