---
name: Object Storage sidecar empty bucket fix
description: Why Replit Object Storage fails at startup and how to fix it
---

# Replit Object Storage — sidecar returns empty bucketId

## The rule
When using Replit App Storage, pass the managed bucket ID explicitly to the
storage client instead of relying on the sidecar to discover it.

**Why:** The development sidecar can return an empty bucket ID even when the
project has a valid bucket configured, causing storage operations to fail with
an unhelpful not-ok response.

**How to apply:** Treat the managed bucket ID as runtime configuration and
verify storage reachability before testing uploads or downloads.

## Imported project attachment

If an imported project's `defaultBucketID` is unreachable in the new Repl, do not
preserve the copied ID by forcing it into a shared environment variable. Use the
App Storage tool to attach the existing bucket or create a replacement, then
restart the API so the managed bucket configuration is injected.

**Why:** Bucket IDs are environment-scoped; a valid ID from the source Repl can
still produce `list returned not-ok` in the destination. Attaching through the
tool updates the project configuration and makes the sidecar reachable.

**How to apply:** Treat HTTP 200 from `/api/healthz` and the startup reachability
log as the storage acceptance criteria before testing uploads or downloads.
