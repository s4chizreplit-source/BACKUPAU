---
name: GitHub remote setup
description: How GitHub auto-push works for this project and its gotchas
---

## Repo
`https://github.com/thedevlovable/autocliper` (older repo `xbhiblackbox/autoacliper` is obsolete).

## Push method (July 2026)
- Replit's `gitPush()` callback does NOT work — no GitHub account linked to Replit.
- Token lives in the `GITHUB_TOKEN` secret and is injected at push time by `.git/hooks/post-commit`; it is never stored in `.git/config`.
- **Why:** platform task-merges once wiped the origin remote (and the tokened URL with it); secrets survive merges. Chat-pasted tokens should be requested via the secrets flow, not chat.
- **How to apply:** push manually with `git push "https://x-access-token:${GITHUB_TOKEN}@github.com/thedevlovable/autocliper.git" HEAD:main` and pipe through `sed "s|x-access-token:[^@]*@|***@|g"` to redact.

## Gotchas
- The hook needs `set -o pipefail` — `git push | sed <redact>` otherwise reports "✓ Pushed" even when the push failed.
- Task-agent forks inherit `.git` at fork time and can push their commits to GitHub before their platform merge lands locally. A rejected (non-fast-forward) push usually means a pending task's work arrived on GitHub early — fetch and merge it, don't force-push.
- `git merge` does not fire the post-commit hook; push manually after merges.

## Cross-task merge gotchas (July 2026)
- After `git merge FETCH_HEAD` of a task agent's work, ALWAYS run the full api-server test suite: two tasks' code often meets for the first time locally (e.g. one task's test file asserts implementation details another task/my session changed — exec vs execFile mocks, stored-id ordering).
- Task agents sometimes commit junk files (a file literally named `-` from a shell redirect typo). Check `git log --stat` of merged commits and delete strays.
- "Everything up-to-date" on manual push after a commit usually means the post-commit hook's retry already pushed it.
