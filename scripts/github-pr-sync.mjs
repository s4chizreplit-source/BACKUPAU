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
import { readFileSync } from "node:fs";
import path from "node:path";
import { ReplitConnectors } from "@replit/connectors-sdk";

const OWNER = "s4chizreplit-source";
const REPO = "BACKUPAU";
const BASE_BRANCH = "main";
const ROOT = process.cwd();
const dryRun = process.argv.includes("--dry-run");

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
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

async function api(conn, route, init) {
  const response = await conn.proxyFetch(route, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub ${init?.method ?? "GET"} ${route} failed (${response.status}): ${body.message ?? "unknown error"}`);
  }
  return body;
}

async function main() {
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

  const connectors = new ReplitConnectors();
  const baseRef = await api(connectors, `/repos/${OWNER}/${REPO}/git/ref/heads/${BASE_BRANCH}`);
  const baseCommitSha = baseRef.object.sha;
  const baseCommit = await api(connectors, `/repos/${OWNER}/${REPO}/git/commits/${baseCommitSha}`);

  const tree = [];
  for (const { status, file } of files) {
    if (status === "D") {
      tree.push({ path: file, mode: "100644", type: "blob", sha: null });
      continue;
    }

    const content = readFileSync(path.join(ROOT, file));
    const blob = await api(connectors, `/repos/${OWNER}/${REPO}/git/blobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.toString("base64"), encoding: "base64" }),
    });
    tree.push({ path: file, mode: "100644", type: "blob", sha: blob.sha });
  }

  const remoteBranch = `replit-update-${shortSha}`;
  const newTree = await api(connectors, `/repos/${OWNER}/${REPO}/git/trees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
  });
  const newCommit = await api(connectors, `/repos/${OWNER}/${REPO}/git/commits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Replit: ${commitMessage}`,
      tree: newTree.sha,
      parents: [baseCommitSha],
    }),
  });
  await api(connectors, `/repos/${OWNER}/${REPO}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${remoteBranch}`, sha: newCommit.sha }),
  });
  const pullRequest = await api(connectors, `/repos/${OWNER}/${REPO}/pulls`, {
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