# Browser (headless) E2E testing

OmniDM's web-ui checks render the **real client** (engine bundle + transport +
portraits + app.js) inside headless chromium and assert on the resulting DOM.
They cover procedural portraits, the token board, the class gallery, the
character creator, and the full **local-mode** and **server-mode** turn flows,
key storage, status states, and roster overflow.

## How they run

All headless checks go through a single helper, `chromiumDumpDom`
(`src/smoke/harness.ts`):

- launches `/usr/bin/chromium` **detached** (its own process group);
- uses the modern headless path: `--headless=new --no-sandbox --disable-gpu
  --no-zygote --ozone-platform=headless --disable-dev-shm-usage`;
- strips `DISPLAY` / `WAYLAND_DISPLAY` from the child environment;
- on timeout, **SIGKILLs the whole process group** so an orphaned gpu/renderer
  child can never hold the stdout pipe open and wedge the suite.

### Why this design

The previous implementation called `spawnSync(chromium, …, { timeout })`
directly per check. On a **Wayland/desktop** host, `chromium --dump-dom` forks
gpu/zygote/renderer children that outlive `spawnSync`'s SIGTERM and keep the
pipe open, so `spawnSync` blocked forever — hanging the entire smoke suite and
leaking chromium processes. The new helper is bounded (always returns within its
timeout) and always reaps the process group.

## Environments

| Environment                 | Behaviour                                                        |
| --------------------------- | --------------------------------------------------------------- |
| **Linux CI (headless)**     | Chromium renders; checks **run and must pass** (required).      |
| **Wayland desktop dev box** | Chromium often can't render `--dump-dom`; checks **skip cleanly**, the suite **completes** (no hang), and orphans are reaped. |
| **No chromium installed**   | Checks skip (reported), suite completes.                        |

CI is the source of truth for the browser layer. `.github/workflows/ci.yml`:

- installs chromium (**required** — the job fails if it can't),
- runs the smoke suite under `xvfb-run`,
- **asserts zero skipped checks** (a skipped browser check fails the job),
- uploads the probe HTML + captured output as artifacts on failure.

## Running locally

```bash
# On a headless machine (or with a working headless chromium):
xvfb-run -a npm run smoke

# On a Wayland desktop: browser checks will skip, the rest runs; the suite
# still completes in bounded time (each headless check times out ~25–35s).
npm run smoke
```

## Known limitation

A Wayland desktop with the distro chromium may not render `--dump-dom` at all
(observed on aarch64). This is an environment limitation, not a product defect:
the checks are designed to run in CI, and the harness guarantees the dev-box run
never hangs. If you need to run the browser checks locally, use a headless
environment (container or `xvfb`).
