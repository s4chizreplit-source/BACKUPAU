---
name: GitHub backup workflow
description: The review-first GitHub backup policy and credential-safety requirements
---

## Rule

Use `https://github.com/s4chizreplit-source/BACKUPAU` as the backup repository. Keep GitHub `main` as the reviewed baseline and send subsequent local commits through pull requests rather than pushing directly to `main`.

**Why:** The user requested automatic, reviewable GitHub backups. The previous repository history produced malformed pack transfers to the new empty repository, so BACKUPAU was seeded from a clean source snapshot; the old history remains available on a local legacy branch.

**How to apply:** Commit completed changes locally and let the repository hook open a GitHub pull request. Keep credentials only in Replit Secrets; never place a token in chat, tracked files, command output, or a git remote URL.
