# Cloudflare deployment

The application uses React and the Next.js App Router with a static export. Next.js builds the static export with webpack under Bun. A small Cloudflare Worker enforces the publication cutoff and adds HTTP byte ranges for the video.

## Cloudflare Pages

Use `bun run build:pages` to build `out/` with a Pages advanced-mode Worker on every route. For a Git-connected project, use the `main` production branch, output directory `out`, and set `BUN_VERSION` to the version pinned in `package.json`. Use `bun install --frozen-lockfile && bun run build:pages` as the build command and set `SKIP_DEPENDENCY_INSTALL=1`. In **Settings → Runtime**, choose **Fail closed** so Pages cannot fall back to serving static files if the Functions quota is exhausted. See [Pages routing](https://developers.cloudflare.com/pages/functions/routing/#fail-open--closed).

Add `claim-by-claim.khademohali.me` under the project's **Custom domains** in Cloudflare. In the IONOS DNS zone for `khademohali.me`, point the `claim-by-claim` CNAME to the Pages project's assigned `pages.dev` hostname. Check HTTPS and the video response using the verification steps below. See [Cloudflare Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/#add-a-custom-subdomain).

## Build and validate

Use the Bun version pinned in `package.json` and install from `bun.lock`.

```sh
bun install --frozen-lockfile
bun run build
bun run test:worker
bun run deploy:prepare
bun run deploy:check
```

The Next.js configuration must use `output: 'export'`. Its build produces `out/`, including HTML, client JavaScript and public media. Server-only Next.js features are outside this deployment model. See [Next.js static exports](https://nextjs.org/docs/app/guides/static-exports).

`deploy/prepare.mjs` packages the existing export and compiles the standalone media Worker with Bun’s TypeScript transpiler. It has no Vite or framework-adapter requirement. It rejects missing exports, symlinks and assets larger than 25 MiB before replacing generated deployment output.

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
    "runWorkerFirst": true
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

## Cloudflare Workers Builds

The standalone Workers deployment tracks the GitHub `main` branch. Set `SKIP_DEPENDENCY_INSTALL=1` as a build variable so the build command performs a frozen install. Workers Builds reads the Bun version from `packageManager`.

- Build command: `bun install --frozen-lockfile && bun run build && bun run deploy:prepare`
- Deploy command: `bun run deploy`

## Authenticate and deploy

Authenticate the CLI with browser OAuth:

```sh
bun --bun cf auth login
bun run deploy
```

For unattended deployment, supply a suitably scoped `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through the CI secret store. Credentials do not belong in source or generated assets. A connected Cloudflare application session is separate from local CLI authentication. See [cf authentication](https://developers.cloudflare.com/cf/get-started/) and [CI credentials](https://developers.cloudflare.com/cf/ci/).

An account Workers subdomain or a custom domain is required for public access. A Workers subdomain produces `https://claim-by-claim.<account-subdomain>.workers.dev/`. Report the actual URL only after deployment and verification.

## Publication cutoff

The current deployment stops serving the site at `2026-12-03T22:24:40Z`. Cloudflare checks the clock before serving HTML, media, or any other asset. Successful HTML responses advertise the deadline in the `Sunset` header; from the cutoff onward, the Worker returns HTTP 410 without reading the asset. To reschedule the cutoff, change `offlineAt` in `deploy/worker.ts`, update the corresponding test date, and redeploy. The timer does not change the GitHub repository or previously deployed immutable preview URLs.

## Video ranges

Workers Static Assets currently returns a full `200` response when given a `Range` request. Safari video playback can require byte-range support, so the Worker handles ranges on `/media/*`. Before the publication cutoff, other paths use normal asset routing. See [Static Assets limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

The Worker streams a single closed, open-ended or suffix byte range. It returns `206` with exact `Content-Range` and `Content-Length`, cancels unread source data, and retains asset validators and cache policy. Invalid, multipart and unsatisfiable ranges receive `416`. `HEAD` returns full-resource metadata without a body. Normal conditional responses take precedence, and `If-Range` requires a strong matching validator. Both builds record the length of the exported MP4 for use when the asset response omits `Content-Length`. Unknown-length or encoded representations fall back to full-file delivery.

The partial response uses [FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#fixedlengthstream), so Workers derives the correct length without buffering the video. Individual assets must remain within the [25 MiB file limit](https://developers.cloudflare.com/workers/platform/limits/). Media Worker invocations also use the applicable Workers request and CPU quotas.

## Verify the deployment

- Confirm the root page, exported routes, public evidence links and a missing-route `404` response.
- Check video `GET`, `HEAD`, `Range: bytes=0-1`, an open-ended range, a suffix range and an unsatisfiable range against the public URL.
- Confirm the partial byte count and `Content-Range` total match the deployed media file.
- Confirm seeking and final-second playback in Safari/WebKit on the deployed site.

Local tests and a CLI dry run validate packaged code and configuration. They do not establish that an authenticated deployment or public-browser check has succeeded.
