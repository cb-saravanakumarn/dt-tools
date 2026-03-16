#!/usr/bin/env node
/**
 * dt-cb-git-contribution-tracker.js
 *
 * Analyses git commits on a branch against a base ref and produces:
 *   1. report-output.txt  — markdown report (for PR comment, backward-compat)
 *   2. report-payload.json — structured JSON (for push-to-sheets.js)
 *
 * Usage:
 *   node dt-contribution-tracker.js --base origin/dt/skills-test
 *   node dt-contribution-tracker.js --base origin/dt/skills-test --dry-run
 *
 * --dry-run wraps the markdown in the DRY RUN markers the existing YAML expects.
 * Both output files are always written regardless of --dry-run.
 *
 * DT member detection (in priority order):
 *   1. DT_MEMBERS env var  "alice,bob,carol"
 *   2. .dt-members file in repo root  (one login per line)
 *   3. Falls back to treating ALL authors as DT if neither is set
 *
 * Environment variables injected by GitHub Actions workflow:
 *   GH_REPO        ${{ github.repository }}
 *   GH_PR_NUMBER   ${{ github.event.pull_request.number }}
 *   GH_PR_TITLE    ${{ github.event.pull_request.title }}
 *   GH_PR_URL      ${{ github.event.pull_request.html_url }}
 *   GH_RUN_ID      ${{ github.run_id }}
 */

"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const baseRef = args[args.indexOf("--base") + 1] || "HEAD~1";
const dryRun = args.includes("--dry-run");

// ─── Git helpers ─────────────────────────────────────────────────────────────
// cwd defaults to process.cwd() — override via GIT_WORK_DIR env if the script
// is invoked from a different directory than the repo (e.g. CI runner root).
const GIT_CWD = process.env.GIT_WORK_DIR || process.cwd();

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

// Returns array of { hash, date, author, message }
function getCommits(base) {
  const log = git(`log ${base}..HEAD --format=%H|%as|%ae|%s`);
  if (!log) return [];
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, date, email, ...msgParts] = line.split("|");
      // Use the part before @ in the email as a fallback login approximation
      // The real GitHub login comes from commit author name if available
      return {
        hash: hash.slice(0, 8),
        date,
        email,
        message: msgParts.join("|"),
      };
    });
}

// Returns array of { hash, author (name), email }
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

// Returns { [hash]: { added, deleted, files: [{file, added, deleted}] } }
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
      // e.g. "src/foo.ts | 12 +++++-----"
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

// Returns first 2000 chars of the combined diff
function getDiffSnapshot(base) {
  const diff = git(
    `diff ${base}..HEAD -- . ':(exclude)package-lock.json' ':(exclude)*.lock'`,
  );
  return diff.slice(0, 2000);
}

// ─── DT member detection ─────────────────────────────────────────────────────
function loadDtMembers() {
  // Priority 1: env var
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
  // Priority 2: .dt-members file in repo root
  const filePath = path.join(process.cwd(), ".dt-members");
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
  // Priority 3: no list — treat all as DT
  console.log("No DT member list found. Treating all authors as DT.");
  return new Set();
}

// Resolve GitHub login from email/name
// git log gives us name + email; GitHub login = name lowercased with spaces→hyphens
// (best effort — override via DT_MEMBERS with exact logins)
function resolveLogin(name, email) {
  // Some setups embed login in email as login@users.noreply.github.com
  const noReply = email.match(/^(\d+\+)?([^@]+)@users\.noreply\.github\.com$/);
  if (noReply) return noReply[2].toLowerCase();
  // Fall back to name → login approximation
  return name.toLowerCase().replace(/\s+/g, "-");
}

// ─── Core analysis ───────────────────────────────────────────────────────────
function analyse(base) {
  const commits = getCommits(base);
  const authors = getCommitAuthors(base);
  const diffStats = getDiffStats(base);
  const dtMembers = loadDtMembers();
  const diffSnap = getDiffSnapshot(base);

  if (commits.length === 0) return null;

  // Build per-author map
  const authorMap = {}; // login → { name, email, type, commits[], shas[], dates[], messages[], filesMap }

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
        filesMap: {}, // file → { dt_lines, total_lines }
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

    // Per-file accumulation
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

  // Build contributors array
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

  // Overwrite detection: which DT files did DEV authors touch?
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

  return {
    contributors: finalContributors,
    diffSnapshot: diffSnap,
    dtFilesSet,
  };
}

// ─── Markdown report builder ─────────────────────────────────────────────────
function buildMarkdown(result, base) {
  const { contributors } = result;
  const dtC = contributors.filter((c) => c.author_type === "DT");
  const devC = contributors.filter((c) => c.author_type === "DEV");

  const totalCommits = contributors.reduce((s, c) => s + c.commit_count, 0);
  const dtCommits = dtC.reduce((s, c) => s + c.commit_count, 0);
  const totalAdded = contributors.reduce((s, c) => s + c.lines_added, 0);
  const dtAdded = dtC.reduce((s, c) => s + c.lines_added, 0);
  const dtPct =
    totalAdded > 0 ? ((dtAdded / totalAdded) * 100).toFixed(1) : "0.0";

  // All files across all contributors
  const allFilesMap = {};
  for (const c of contributors) {
    for (const f of c.files_detail) {
      if (!allFilesMap[f.file])
        allFilesMap[f.file] = { dt_lines: 0, total_lines: 0 };
      allFilesMap[f.file].dt_lines += f.dt_lines || 0;
      allFilesMap[f.file].total_lines += f.total_lines || 0;
    }
  }
  const allFiles = Object.values(allFilesMap).sort(
    (a, b) => b.total_lines - a.total_lines,
  );

  // All commits sorted by date desc
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
  lines.push("## DT Contribution Report");
  lines.push("");
  lines.push(`**Branch:** \`HEAD\``);
  lines.push(`**Base:** \`${base}\``);
  lines.push(
    `**Generated:** ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
  );
  lines.push("");
  lines.push("### Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Total commits | ${totalCommits} |`);
  lines.push(`| DT commits | ${dtCommits} |`);
  lines.push(`| Developer commits | ${totalCommits - dtCommits} |`);
  lines.push(`| Total lines added | ${totalAdded} |`);
  lines.push(`| DT lines added | ${dtAdded} |`);
  lines.push(`| **DT contribution** | **${dtPct}%** |`);
  lines.push(`| Files touched | ${allFiles.length} |`);
  lines.push("");

  if (allFiles.length > 0) {
    lines.push("### Per-File Breakdown");
    lines.push("");
    lines.push("| File | DT Lines | Total Lines | DT% |");
    lines.push("|---|---|---|---|");
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
    lines.push("### DT Commit Log");
    lines.push("");
    lines.push("| Hash | Date | Author | Type | Message |");
    lines.push("|---|---|---|---|---|");
    for (const c of allCommits) {
      const badge = c.type === "DT" ? "🟢 DT" : "🔵 DEV";
      lines.push(
        `| \`${c.sha}\` | ${c.date} | ${c.author} | ${badge} | ${c.message} |`,
      );
    }
    lines.push("");
  }

  // Overwrite section (only if DEV touched DT files)
  const overwrites = contributors.filter(
    (c) => c.author_type === "DEV" && c.dev_lines_on_dt_files > 0,
  );
  if (overwrites.length > 0) {
    lines.push("### Overwrites on DT Work");
    lines.push("");
    lines.push("| Author | Lines on DT Files | Files |");
    lines.push("|---|---|---|");
    for (const c of overwrites) {
      lines.push(
        `| ${c.author} | ${c.dev_lines_on_dt_files} | \`${c.dt_files_touched.replace(/,/g, "`, `")}\` |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── JSON payload builder ────────────────────────────────────────────────────
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

// ─── Main ────────────────────────────────────────────────────────────────────
(function main() {
  console.log(`Analysing commits from ${baseRef} to HEAD…`);

  const result = analyse(baseRef);

  if (!result || result.contributors.length === 0) {
    console.log("No commits found between base and HEAD.");
    // Write empty markers so the YAML comment step exits cleanly
    fs.writeFileSync("report-output.txt", "");
    fs.writeFileSync("report-payload.json", "{}");
    process.exit(0);
  }

  // ── Write markdown (report-output.txt) ──────────────────────────────────
  const markdown = buildMarkdown(result, baseRef);

  let reportText;
  if (dryRun) {
    // Wrap in markers the existing YAML comment step expects
    reportText = ["DRY RUN: Report preview", markdown, "End of dry run"].join(
      "\n",
    );
  } else {
    reportText = markdown;
  }

  fs.writeFileSync("report-output.txt", reportText, "utf8");
  console.log("Written: report-output.txt");

  // ── Write JSON payload (report-payload.json) ─────────────────────────────
  const payload = buildPayload(result, baseRef);
  fs.writeFileSync(
    "report-payload.json",
    JSON.stringify(payload, null, 2),
    "utf8",
  );
  console.log("Written: report-payload.json");

  // Summary to stdout
  const dtC = result.contributors.filter((c) => c.author_type === "DT");
  const totalAdded = result.contributors.reduce((s, c) => s + c.lines_added, 0);
  const dtAdded = dtC.reduce((s, c) => s + c.lines_added, 0);
  console.log(`Contributors: ${result.contributors.length} (${dtC.length} DT)`);
  console.log(
    `Lines: ${dtAdded}/${totalAdded} DT (${totalAdded > 0 ? ((dtAdded / totalAdded) * 100).toFixed(1) : 0}%)`,
  );
})();
