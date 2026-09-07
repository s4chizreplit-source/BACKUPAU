#!/usr/bin/env node

/*
 * Mirror a local commit to a GitHub pull request using the Replit GitHub
 * connector. No token is read from the environment, git config, or disk.
 *
 * Usage:
 *   node scripts/github-pr-sync.mjs
 *   node scripts/github-pr-sync.mjs --dry-run
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const OWNER = "s4chizreplit-source";
const REPO = "BACKUPAU";
const BASE_BRANCH = "main";
const ROOT = process.cwd();
const dryRun = process.argv.includes("--dry-run");

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function pushBranch(token, branch) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "github-sync-"));
  const askpass = path.join(tempDir, "askpass.sh");
  writeFileSync(askpass, [
    "#!/bin/sh",
    "case \"$1\" in",
    "  *Username*) printf '%s\\n' 'x-access-token' ;;",
    "  *Password*) printf '%s\\n' \"$BACKUPAU_GITHUB_TOKEN\" ;;",
    "esac",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(askpass, 0o700);

  try {
    execFileSync("git", [
      "push",
      `https://github.com/${OWNER}/${REPO}.git`,
      `HEAD:refs/heads/${branch}`,
    ], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        BACKUPAU_GITHUB_TOKEN: token,
        GIT_ASKPASS: askpass,
        GIT_ASKPASS_REQUIRE: "force",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function changedFiles(commit) {
  const output = git("diff-tree", "--no-commit-id", "--name-status", "-r", commit);
  if (!output) return [];

  return output.split("\n").flatMap((line) => {
    const [status, ...names] = line.split("\t");
    // Rename/copy records contain old and new paths; the new path is the one
    // whose content should be uploaded.
    const file = status.startsWith("R") || status.startsWith("C") ? names.at(-1) : names[0];
    return file ? [{ status: status[0], file }] : [];
  });
}

async function api(token, route, init) {
  const response = await fetch(`https://api.github.com${route}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub ${init?.method ?? "GET"} ${route} failed (${response.status}): ${body.message ?? "unknown error"}`);
  }
  return body;
}

async function main() {
  const token = process.env.BACKUPAU_GITHUB_TOKEN;
  if (!token) throw new Error("BACKUPAU_GITHUB_TOKEN is not configured.");

  const commitSha = git("rev-parse", "HEAD");
  const shortSha = commitSha.slice(0, 8);
  const commitMessage = git("log", "-1", "--pretty=%s", commitSha);
  const files = changedFiles(commitSha);

  if (files.length === 0) {
    console.log("[github-sync] No changed files in the latest commit.");
    return;
  }

  const summary = files.map(({ status, file }) => `${status} ${file}`).join(", ");
  if (dryRun) {
    console.log(`[github-sync] Dry run: ${files.length} file(s) from ${shortSha}: ${summary}`);
    return;
  }

  const remoteBranch = `replit-update-${shortSha}`;
  pushBranch(token, remoteBranch);

  const existing = await api(token, `/repos/${OWNER}/${REPO}/pulls?state=open&head=${OWNER}%3A${remoteBranch}&base=${BASE_BRANCH}`);
  if (existing.length > 0) {
    console.log(`[github-sync] PR already open: ${existing[0].html_url}`);
    return;
  }

  const pullRequest = await api(token, `/repos/${OWNER}/${REPO}/pulls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `Replit update: ${commitMessage}`,
      head: remoteBranch,
      base: BASE_BRANCH,
      body: [
        "This pull request was created automatically from a Replit commit.",
        "",
        `Source commit: ${commitSha}`,
        `Changed files: ${files.length}`,
      ].join("\n"),
    }),
  });

  console.log(`[github-sync] Opened PR #${pullRequest.number}: ${pullRequest.html_url}`);
}

main().catch((error) => {
  console.error(`[github-sync] ${error.message}`);
  process.exitCode = 1;
});