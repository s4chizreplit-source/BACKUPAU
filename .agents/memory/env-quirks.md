---
name: Workspace environment quirks
description: Replit workspace behaviors that break naive testing/automation approaches
---

# Background processes get reaped

Long-running background node scripts (`setsid nohup node x.cjs &`) are killed by
the environment within roughly a minute of the launching shell exiting — twice
observed: an e2e script died mid-poll, a smoke script died right after its first
request. Logs just stop; no error line.

**Why:** the shell-exec harness reaps orphaned process groups; setsid does not
protect against it.

**How to apply:** run long e2e/smoke scripts in a FOREGROUND shell command with
an adequate timeout (≤300s per call). For jobs longer than that, poll durable
state (e.g. `/tmp/clipai-jobs/*.json` job records, DB rows) from fresh shell
calls instead of keeping one script alive. The environment can also restart
spontaneously, wiping /tmp and stopping workflows — restart workflows and
re-verify after any suspicious silence.

- **Editing ClipperPage while the user runs a clip job in dev orphans their screen.** Vite HMR invalidate kills the in-flight polling loop; the server still finishes the job. Diagnose via `/tmp/clipai-jobs/*.json` (status often `done` while the UI sits frozen) before assuming the pipeline hung. UI now stores the active job id in localStorage and reconnects on load — but old tabs opened before that code won't self-heal; user must refresh and use History.

## VM deployments carry REPLIT_DEV_DOMAIN — PUBLIC_APP_URL is mandatory
The production VM deployment has REPLIT_DEV_DOMAIN in its env (pointing at the sleeping workspace preview). `getPublicAppBase()`'s dev-domain fallback therefore "works" in prod and silently mints relay/media URLs on the workspace domain — Post for Me stored `*.sisko.replit.dev` media URLs and every publish failed with "All media failed to process" whenever the workspace slept (observed 2026-08-21).
**How to apply:** set PUBLIC_APP_URL as a production env var AND republish after setting it (deployments snapshot env at publish). When a third-party provider reports fetch/media failures, first check WHICH domain it was actually given (fetch the provider's stored record) before debugging the endpoint itself.

## Production executeSql is READ-ONLY
UPDATE/INSERT against the deployed DB from the workspace fails with "cannot execute UPDATE in a read-only transaction". Prod data repairs must ride on app behavior: e.g. delete+recreate an Auto-Pilot campaign to reset its items/plans (create-day scheduling posts missed slots ASAP), pause to free consumed items.

## Parallel vitest runs share the dev DB
Running the api suite in a shell while the `api-server-test` workflow is also running → cross-run flakes in unrelated files (e.g. fileAuth, uploads). If untouched files fail, re-run alone before debugging.

## NODE_ENV guards are DEAD in test workflows — gate on VITEST
The workspace shell exports `NODE_ENV=development` globally, and vitest only sets `NODE_ENV=test` when it was unset — so every `NODE_ENV !== "test"` guard around background timers (campaign materializer sweeps, schedule-queue drains) stayed ACTIVE inside test processes. Observed 2026-08-20: a test-process boot sweep planned a real dev-DB campaign under the test file's mocked account-ownership, and its brief row locks made a `FOR UPDATE SKIP LOCKED` path in the test silently no-op (flaky "day not consumed" failure).
**How to apply:** gate test-only suppression on `process.env.VITEST !== undefined` (vitest always sets it) in addition to NODE_ENV; never trust NODE_ENV alone here. Tests that drive lock-skipping functions against the shared dev DB should retry until the expected state lands (the dev server's own sweeps still hold those locks for a few ms).

## Heredocs silently split `&&` chains
`cmd1 && cat > file <<'EOF' … EOF` followed by more commands: everything after the heredoc terminator runs as a NEW statement even when the chain before it failed — commits/cleanup can run despite failed tests (happened twice on 2026-08-13). Put heredoc writes FIRST (or use the file-write tool), keep verify→commit as one pure `&&` chain with no heredoc in the middle.

## Filtered `pnpm add` can break sibling packages
`pnpm --filter <pkg> add X` re-pruned the workspace and left another package's node_modules missing its test runner ("Cannot find module …/vitest/vitest.mjs", typecheck "Cannot find module 'vitest'"). After any dependency change in one package, run root `pnpm install` and re-verify the OTHER package's suite before blaming the repo.

## PUBLIC_APP_URL is inert until the VM restarts
Setting/fixing a production env var does NOT reach the already-running VM deploy — it only applies on the next restart/redeploy. Symptom while stale: background-drain hand-offs mint `https://<REPLIT_DEV_DOMAIN>/...` media/relay URLs from prod, and the provider fails at publish time with "All media failed to process"; request-path hand-offs look fine (forwarded headers give the right host), which masks the bug.
**How to apply:** after changing prod env vars, confirm the VM restarted; verify by fetching a provider post record and checking the media URL host. getPublicAppBase now returns "" (loud PUBLIC_APP_URL error at hand-off) instead of the dev-domain fallback when NODE_ENV=production or REPLIT_DEPLOYMENT is set.

## Imported VM build yt-dlp destination
Imported projects may contain `bin/yt-dlp` as a symlink into the read-only Nix store. A publishing build that downloads the production binary to that path must remove the destination first, or `curl` fails with permission denied after compilation succeeds.
**Why:** the deployment builder follows the existing symlink instead of replacing it, so the otherwise healthy build fails at its final tool download step.
**How to apply:** keep the runtime path stable, but run `rm -f /home/runner/workspace/bin/yt-dlp` immediately before the production `curl -o` download.
