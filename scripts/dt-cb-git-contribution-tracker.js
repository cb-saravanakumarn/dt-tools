#!/usr/bin/env node
/**
 * dt-cb-git-contribution-tracker.js
 *
 * Analyses git commits on a branch against a base ref and produces:
 *   1. report-output.txt   — markdown report (for PR comment)
 *   2. report-payload.json — structured JSON (for push-to-sheets.js)
 *
 * Usage:
 *   node dt-cb-git-contribution-tracker.js \
 *     --base origin/dt/skills-test \
 *     --repo-dir /absolute/path/to/repo \
 *     --dry-run
 *
 * DT member detection (priority order):
 *   1. DT_MEMBERS env var  e.g. "alice,bob,carol"
 *   2. .dt-members file in repo root (one login per line)
 *   3. Treats ALL authors as DT if neither is set
 *
 * GitHub Actions env vars (injected by YAML):
 *   GH_REPO, GH_PR_NUMBER, GH_PR_TITLE, GH_PR_URL, GH_RUN_ID
 */

"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── CLI args — parse FIRST before anything else ─────────────────────────────
const args = process.argv.slice(2);
const baseRef = args[args.indexOf("--base") + 1] || "HEAD~1";
const dryRun = args.includes("--dry-run");
const repoDirIdx = args.indexOf("--repo-dir");
const repoDir = repoDirIdx !== -1 ? args[repoDirIdx + 1] : null;

console.log(`[ARGS] base=${baseRef} dryRun=${dryRun} repoDir=${repoDir}`);
console.log(`[ARGS] full argv=${JSON.stringify(process.argv)}`);

// ─── Paths ────────────────────────────────────────────────────────────────────
// GIT_CWD: where git commands run — must be the PR repo checkout
// OUT_DIR: where output files are written — always runner root (process.cwd())
const GIT_CWD = repoDir || process.env.GIT_WORK_DIR || process.cwd();
const OUT_DIR = process.cwd();

console.log(`[PATHS] GIT_CWD=${GIT_CWD}`);
console.log(`[PATHS] OUT_DIR=${OUT_DIR}`);

// ─── Git helpers ──────────────────────────────────────────────────────────────
function git(cmd) {
  try {
    return execSync(`git ${cmd}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: GIT_CWD,
    }).trim();
  } catch (e) {
    return "";
  }
}

// ─── Git data fetchers ────────────────────────────────────────────────────────
function getCommits(base) {
  const log = git(`log ${base}..HEAD --format=%H|%as|%ae|%s`);
  if (!log) return [];
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, date, email, ...msgParts] = line.split("|");
      return {
        hash: hash.slice(0, 8),
        date,
        email,
        message: msgParts.join("|"),
      };
    });
}

function getCommitAuthors(base) {
  const log = git(`log ${base}..HEAD --format=%H|%aN|%ae`);
  if (!log) return [];
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, name, email] = line.split("|");
      return { hash, name, email };
    });
}

function getDiffStats(base) {
  const commits = git(`log ${base}..HEAD --format=%H`);
  if (!commits) return {};
  const stats = {};
  for (const hash of commits.split("\n").filter(Boolean)) {
    const raw = git(`show --stat --format= ${hash}`);
    const files = [];
    let totalAdded = 0,
      totalDeleted = 0;
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*(.+?)\s+\|\s+\d+\s*([+\-]*)/);
      if (m) {
        const added = (m[2].match(/\+/g) || []).length;
        const deleted = (m[2].match(/-/g) || []).length;
        files.push({ file: m[1].trim(), added, deleted });
        totalAdded += added;
        totalDeleted += deleted;
      }
    }
    stats[hash] = { added: totalAdded, deleted: totalDeleted, files };
  }
  return stats;
}

function getDiffSnapshot(base) {
  const diff = git(
    `diff ${base}..HEAD -- . ":(exclude)package-lock.json" ":(exclude)*.lock"`,
  );
  return diff.slice(0, 2000);
}

// ─── DT member detection ──────────────────────────────────────────────────────
function loadDtMembers() {
  const env = process.env.DT_MEMBERS || "";
  if (env.trim()) {
    const members = new Set(
      env
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    console.log(
      `DT members loaded from DT_MEMBERS env (${members.size}): ${[...members].join(", ")}`,
    );
    return members;
  }
  const filePath = path.join(GIT_CWD, ".dt-members");
  if (fs.existsSync(filePath)) {
    const members = new Set(
      fs
        .readFileSync(filePath, "utf8")
        .split("\n")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s && !s.startsWith("#")),
    );
    console.log(
      `DT members loaded from .dt-members file (${members.size}): ${[...members].join(", ")}`,
    );
    return members;
  }
  console.log("No DT member list found. Treating all authors as DT.");
  return new Set();
}

function resolveLogin(name, email) {
  const noReply = email.match(/^(\d+\+)?([^@]+)@users\.noreply\.github\.com$/);
  if (noReply) return noReply[2].toLowerCase();
  return name.toLowerCase().replace(/\s+/g, "-");
}

// ─── Core analysis ────────────────────────────────────────────────────────────
function analyse(base) {
  const commits = getCommits(base);
  const authors = getCommitAuthors(base);
  const diffStats = getDiffStats(base);
  const dtMembers = loadDtMembers();
  const diffSnap = getDiffSnapshot(base);

  console.log(`[ANALYSE] commits=${commits.length} authors=${authors.length}`);

  if (commits.length === 0) return null;

  const authorMap = {};

  for (const a of authors) {
    const login = resolveLogin(a.name, a.email);
    const type =
      dtMembers.size === 0 ? "DT" : dtMembers.has(login) ? "DT" : "DEV";

    if (!authorMap[login]) {
      authorMap[login] = {
        login,
        name: a.name,
        email: a.email,
        author_type: type,
        commit_count: 0,
        lines_added: 0,
        lines_deleted: 0,
        shas: [],
        dates: [],
        messages: [],
        filesMap: {},
      };
    }

    const stat = diffStats[a.hash] || { added: 0, deleted: 0, files: [] };
    const commit = commits.find(
      (c) => a.hash.startsWith(c.hash) || c.hash.startsWith(a.hash.slice(0, 8)),
    );

    authorMap[login].commit_count++;
    authorMap[login].lines_added += stat.added;
    authorMap[login].lines_deleted += stat.deleted;
    authorMap[login].shas.push(a.hash.slice(0, 8));
    if (commit) {
      authorMap[login].dates.push(commit.date);
      authorMap[login].messages.push(commit.message);
    }

    for (const f of stat.files) {
      if (!authorMap[login].filesMap[f.file]) {
        authorMap[login].filesMap[f.file] = {
          file: f.file,
          dt_lines: 0,
          dev_lines: 0,
          total_lines: 0,
        };
      }
      authorMap[login].filesMap[f.file].total_lines += f.added;
      if (type === "DT") authorMap[login].filesMap[f.file].dt_lines += f.added;
      else authorMap[login].filesMap[f.file].dev_lines += f.added;
    }
  }

  const contributors = Object.values(authorMap).map((a) => ({
    author: a.login,
    author_type: a.author_type,
    commit_count: a.commit_count,
    lines_added: a.lines_added,
    lines_deleted: a.lines_deleted,
    files_changed: Object.keys(a.filesMap).length,
    commit_shas: a.shas,
    commit_dates: a.dates,
    commit_messages: a.messages,
    files_detail: Object.values(a.filesMap),
  }));

  const dtFilesSet = new Set(
    contributors
      .filter((c) => c.author_type === "DT")
      .flatMap((c) => c.files_detail.map((f) => f.file)),
  );

  const finalContributors = contributors.map((c) => {
    const dtOverlap = c.files_detail.filter((f) => dtFilesSet.has(f.file));
    const devLinesOnDtFiles =
      c.author_type === "DEV"
        ? dtOverlap.reduce((s, f) => s + f.total_lines, 0)
        : 0;
    return {
      ...c,
      dt_files_touched: dtOverlap.map((f) => f.file).join(","),
      dev_lines_on_dt_files: devLinesOnDtFiles,
    };
  });

  return { contributors: finalContributors, diffSnapshot: diffSnap };
}

// ─── Markdown builder ─────────────────────────────────────────────────────────
function buildMarkdown(result, base) {
  const { contributors } = result;
  const dtC = contributors.filter((c) => c.author_type === "DT");
  const totalCommits = contributors.reduce((s, c) => s + c.commit_count, 0);
  const dtCommits = dtC.reduce((s, c) => s + c.commit_count, 0);
  const totalAdded = contributors.reduce((s, c) => s + c.lines_added, 0);
  const dtAdded = dtC.reduce((s, c) => s + c.lines_added, 0);
  const dtPct =
    totalAdded > 0 ? ((dtAdded / totalAdded) * 100).toFixed(1) : "0.0";

  const allFilesMap = {};
  for (const c of contributors) {
    for (const f of c.files_detail) {
      if (!allFilesMap[f.file])
        allFilesMap[f.file] = { file: f.file, dt_lines: 0, total_lines: 0 };
      allFilesMap[f.file].dt_lines += f.dt_lines || 0;
      allFilesMap[f.file].total_lines += f.total_lines || 0;
    }
  }
  const allFiles = Object.values(allFilesMap).sort(
    (a, b) => b.total_lines - a.total_lines,
  );
  const allCommits = contributors
    .flatMap((c) =>
      c.commit_shas.map((sha, i) => ({
        sha,
        date: c.commit_dates[i] || "",
        message: c.commit_messages[i] || "",
        author: c.author,
        type: c.author_type,
      })),
    )
    .sort((a, b) => b.date.localeCompare(a.date));

  const lines = [];
  lines.push("## DT Contribution Report", "");
  lines.push(`**Branch:** \`HEAD\``);
  lines.push(`**Base:** \`${base}\``);
  lines.push(
    `**Generated:** ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
    "",
  );
  lines.push("### Summary", "");
  lines.push("| Metric | Value |", "|---|---|");
  lines.push(`| Total commits | ${totalCommits} |`);
  lines.push(`| DT commits | ${dtCommits} |`);
  lines.push(`| Developer commits | ${totalCommits - dtCommits} |`);
  lines.push(`| Total lines added | ${totalAdded} |`);
  lines.push(`| DT lines added | ${dtAdded} |`);
  lines.push(`| **DT contribution** | **${dtPct}%** |`);
  lines.push(`| Files touched | ${allFiles.length} |`, "");

  if (allFiles.length > 0) {
    lines.push("### Per-File Breakdown", "");
    lines.push("| File | DT Lines | Total Lines | DT% |", "|---|---|---|---|");
    for (const f of allFiles) {
      const pct =
        f.total_lines > 0
          ? ((f.dt_lines / f.total_lines) * 100).toFixed(1)
          : "0.0";
      lines.push(
        `| \`${f.file}\` | ${f.dt_lines} | ${f.total_lines} | ${pct}% |`,
      );
    }
    lines.push("");
  }

  if (allCommits.length > 0) {
    lines.push("### DT Commit Log", "");
    lines.push(
      "| Hash | Date | Author | Type | Message |",
      "|---|---|---|---|---|",
    );
    for (const c of allCommits) {
      const badge = c.type === "DT" ? "🟢 DT" : "🔵 DEV";
      lines.push(
        `| \`${c.sha}\` | ${c.date} | ${c.author} | ${badge} | ${c.message} |`,
      );
    }
    lines.push("");
  }

  const overwrites = contributors.filter(
    (c) => c.author_type === "DEV" && c.dev_lines_on_dt_files > 0,
  );
  if (overwrites.length > 0) {
    lines.push("### Overwrites on DT Work", "");
    lines.push("| Author | Lines on DT Files | Files |", "|---|---|---|");
    for (const c of overwrites) {
      lines.push(
        `| ${c.author} | ${c.dev_lines_on_dt_files} | \`${c.dt_files_touched.replace(/,/g, "`, `")}\` |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── JSON payload builder ─────────────────────────────────────────────────────
function buildPayload(result, base) {
  return {
    timestamp: new Date().toISOString(),
    repo: process.env.GH_REPO || "",
    pr_number: process.env.GH_PR_NUMBER || "",
    pr_title: process.env.GH_PR_TITLE || "",
    pr_url: process.env.GH_PR_URL || "",
    base_branch: base.replace(/^origin\//, ""),
    workflow_run_id: process.env.GH_RUN_ID || "",
    diff_snapshot: result.diffSnapshot,
    contributors: result.contributors,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(function main() {
  console.log(`Analysing commits from ${baseRef} to HEAD…`);

  const result = analyse(baseRef);

  if (!result || result.contributors.length === 0) {
    console.log("No commits found between base and HEAD.");
    fs.writeFileSync(path.join(OUT_DIR, "report-output.txt"), "", "utf8");
    fs.writeFileSync(path.join(OUT_DIR, "report-payload.json"), "{}", "utf8");
    process.exit(0);
  }

  const markdown = buildMarkdown(result, baseRef);
  const reportText = dryRun
    ? ["DRY RUN: Report preview", markdown, "End of dry run"].join("\n")
    : markdown;

  const reportPath = path.join(OUT_DIR, "report-output.txt");
  const payloadPath = path.join(OUT_DIR, "report-payload.json");
  const payload = buildPayload(result, baseRef); // ← defined before use

  fs.writeFileSync(reportPath, reportText, "utf8");
  fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Written: ${reportPath}`);
  console.log(`Written: ${payloadPath}`);

  const dtC = result.contributors.filter((c) => c.author_type === "DT");
  const totAdded = result.contributors.reduce((s, c) => s + c.lines_added, 0);
  const dtAdded = dtC.reduce((s, c) => s + c.lines_added, 0);
  console.log(`Contributors: ${result.contributors.length} (${dtC.length} DT)`);
  console.log(
    `Lines: ${dtAdded}/${totAdded} DT (${totAdded > 0 ? ((dtAdded / totAdded) * 100).toFixed(1) : 0}%)`,
  );
})();
