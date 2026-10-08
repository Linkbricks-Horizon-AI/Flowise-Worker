# Deployment & Build Troubleshooting (Render)

Operational notes for building and deploying this fork on Render. Keep this file in
sync across the source repo and the deploy forks.

## Deploy topology

```
FlowiseAI/Flowise                               ← upstream reference
  └─ Linkbricks-Horizon-AI/Flowise               ← integration source / Render MAIN
       └─ Linkbricks-Horizon-AI/Flowise-Worker   ← synchronized source / Render WORKER
```

- Runtime is **QUEUE mode**: web + worker + PostgreSQL + Redis/Valkey (Singapore region).
- Changes from any other development fork must first be integrated into both Linkbricks
  repositories. The 2026-10-09 integration uses those two repositories as its release pair.
- A **failed Docker build does not take down the running service** — Render keeps the previous
  version live until a new build succeeds. So a broken build is safe to iterate on.

---

## Issue: `pnpm install` fails — `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` (flowise-embed)

### Symptom (Docker build, step `RUN pnpm install && pnpm build:docker`)

```
ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED  Failed to prepare git-hosted package fetched from
"https://codeload.github.com/saxoji/FlowiseChatEmbed/tar.gz/<hash>": The git-hosted package
"flowise-embed@3.0.5" needs to execute build scripts but is not in the
"onlyBuiltDependencies" allowlist.
```

### Root cause

- **pnpm 10.26+** introduced a strict allowlist gate for **git-hosted dependencies** that run
  `prepare`/build scripts.
- The Dockerfile installed pnpm **unpinned** (`npm install -g pnpm`), so the build pulled the
  latest 10.x (10.34.3) and the gate became active. This is **not** an upstream FlowiseAI code
  change — upstream uses the npm-published `flowise-embed` (prebuilt, no `prepare`), so it never
  hits the gate. This fork uses `flowise-embed: github:saxoji/FlowiseChatEmbed` (git-hosted →
  must be built from source → gated).
- Only reproduces on a **cold pnpm store** (a fresh Docker build). A warm local store skips the
  `prepare` step and hides the failure.

### Current fix — Node 24.21.0 / pnpm 10.26.0 (2026-10-09)

The earlier incident used pnpm 10.34.3 and was temporarily mitigated by pinning
10.25.0. Its tarball-URL allowlist workaround is **not valid in pnpm 10.26.0**:
that version rejects the URL with `ERR_PNPM_INVALID_VERSION_UNION`.

The current configuration was verified with a cache-free Linux amd64 Docker build:

1. Pin Node to `24.21.0` and pnpm to `10.26.0` in Docker, CI and the root manifest.
2. Keep `onlyBuiltDependencies` exclusively in `pnpm-workspace.yaml`:
   ```yaml
   onlyBuiltDependencies:
       - faiss-node
       - sqlite3
       - flowise-embed
       - canvas
       - sharp
   ```
3. Pin `flowise-embed` to the existing custom Git commit
   `1404920a3c279b52bdafe97936d35f16ec61e752` in `packages/ui/package.json` and
   commit the matching `pnpm-lock.yaml`.
4. Install using `pnpm install --frozen-lockfile`. `HUSKY=0` disables development
   Git hook installation in the container; the embed prepare/build still runs.

Do not copy allowlist syntax between pnpm releases without a fresh-store test.
Do not reintroduce a second allowlist in root `package.json`.

### Reproduce / validate locally

Run from the repository root. The image build installs the pinned workspace,
including the custom embed, without a prepopulated pnpm store:

```bash
docker build --platform linux/amd64 --no-cache -t flowise-review .
node scripts/check-worker-sync.mjs /path/to/Flowise /path/to/Flowise-Worker
```

---

## Maintenance notes

- **Always pin pnpm** in the Dockerfile (never unpinned `npm install -g pnpm`) to avoid silent
  version drift that re-triggers gates like the one above.
- Revalidate allowlist behavior and native modules before changing the pinned pnpm version.
- This troubleshooting file should be kept identical in `saxoji/Flowise`,
  `Linkbricks-Horizon-AI/Flowise`, and `Linkbricks-Horizon-AI/Flowise-Worker`.

## Manual Render release

Use repository root as Docker build context and `Dockerfile` as the Dockerfile path
for each repository. The Web image defaults to `pnpm start`; the Worker image defaults
to `pnpm run start-worker`. Check for an existing Render Docker Command override.
`docker/Dockerfile` also builds this fork from source; it no longer installs the npm
upstream distribution. `docker/worker/Dockerfile` is the separate optional HTTP
healthcheck worker variant.

Deploy Worker first, confirm its Redis connection, then deploy Web. Set the Render
Health Check Path to `/api/v1/ready`; `/api/v1/ping` remains the compatibility liveness endpoint.
Verify an existing Vora flow, streaming, cancellation and file upload
against the production service. Render environment variables, secrets and deployment
settings remain managed in the Dashboard. Deployments in this release are performed
manually by the owner.

For every future update, follow [the paired update procedure](reviews/2026-10-09-node24-integration.md)
and run the source parity check before pushing both repositories.

## `ERR_ERL_PERMISSIVE_TRUST_PROXY` and service restarts

The former default `trust proxy: true` trusted every address in `X-Forwarded-For`.
`express-rate-limit` logs `ERR_ERL_PERMISSIVE_TRUST_PROXY` for that setting because
a client could change its rate-limit identity by supplying the leading address.

The server now uses the following policy:

- Unset or blank `TRUST_PROXY`: use `NUMBER_OF_PROXIES` if present, otherwise trust
  only the nearest proxy (`1`).
- Legacy `TRUST_PROXY=true`: also trust one proxy; it no longer enables unlimited trust.
- An explicit non-negative integer: trust that many hops. `false` or `0` disables proxy trust.
- Explicit proxy IP/CIDR lists and Express subnet names remain supported.
- `TRUST_PROXY` takes precedence over `NUMBER_OF_PROXIES`.

Existing Render deployments without either variable receive the bounded default
without an environment change. One hop is a starting point, not a verified count
for every custom domain or CDN path. Check the existing `/api/v1/ip`
endpoint against your public client IP through each supported ingress path. Set
an explicit count or trusted proxy address list when the topology requires it;
avoid increasing the count beyond the shortest path. See the
[Express proxy guide](https://expressjs.com/en/guide/behind-proxies/) and
[rate-limit proxy troubleshooting guide](https://express-rate-limit.mintlify.app/guides/troubleshooting-proxy-issues).

The limiter's validation error is logged and caught by express-rate-limit 6.11.2;
it does not itself exit the process. `ELIFECYCLE` reports that the command ended,
not why it ended. The CLI now logs `Received SIGTERM` or `Received SIGINT` before
graceful shutdown, without changing shutdown behavior.

Keep the Web Health Check Path at `/api/v1/ready`. This endpoint runs before
authentication and rate limiting, and returns 200 after initialization or 503
when not ready. Render restarts a running instance after 60 seconds of failing
health checks, but matching timing alone does not prove that was the cause.
If shutdown continues, correlate Render Events, the instance/deploy ID, exit
status and the signal/error immediately before shutdown. Check for failed health
checks, deploy replacement, restarts or resource limits in the platform events.
See [Render health checks](https://render.com/docs/health-checks).

## Startup warnings from `run-script-os` on Node 24

The former startup wrapper launched npm using `spawn` with arguments and
`shell: true`. Node 24 reported `DEP0190`, and the nested npm process reported
pnpm-specific `.npmrc` and environment settings as unknown configuration. These
messages alone are warnings, not evidence that the server failed to start.

The root and server package scripts now invoke the existing CLI through Node
directly, retaining the `packages/server/bin` working directory. Web, Worker,
user administration and the development CLI no longer depend on `run-script-os`.
The OS-specific script aliases remain available. Keep using `pnpm start` for
Web and `pnpm run start-worker` for Worker; keep the pnpm `.npmrc` settings.

To check command dispatch without starting a service:

```bash
pnpm start --help
pnpm run start-worker --help
pnpm run user --help
```

These commands should show the Flowise CLI help without `DEP0190` or npm's
`Unknown env/project config` warnings. Check actual Web readiness at
`/api/v1/ping` and Worker connection logs separately.

## Native module checks on Node 24

The images use `node:24.21.0-bookworm-slim`. The previously used Alpine image could
start the server while its ONNX dependency aborted when loaded. Debian/glibc
supports the existing ONNX binary. Canvas is pinned to 3.2.0 and its install script
is explicitly allowed. Sharp is unified at 0.33.5: loading its former 0.32.6 and 0.33.5
native libraries in one process reproduced `munmap_chunk(): invalid pointer`. Canvas 2.x was present without a usable native binary.

Every image build runs `node scripts/check-runtime-dependencies.cjs` after the
application build. It checks SQLite queries, FAISS search, Canvas PNG generation,
shared Sharp decoding, Transformers image resizing, ONNX native loading/tensors and the proxy event dependency. A
failure prevents that image from being published or deployed. An ONNX tensor check
does not replace model-specific inference validation.

The upstream global `@tootallnate/once@3.0.1` override is replaced with the patched
CommonJS-compatible `2.0.1`. This preserves the security correction without forcing
an ESM dependency into older proxy clients and Jest 29. See the
[maintainer advisory](https://github.com/advisories/GHSA-vpq2-c234-7xj6) and
[Canvas Node 24 fix](https://github.com/Automattic/node-canvas/releases/tag/v3.2.0).
