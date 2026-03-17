# DT Contribution Tracker — Complete Handover Documentation

> **Owner:** Saravanakumar N (cb-saravanakumarn)
> **Status:** Live — tracking active on `chargebee/chargebee-ui-v2`
> **Last updated:** March 2026

---

## Table of Contents

1. [Background & Purpose](#1-background--purpose)
2. [System Architecture](#2-system-architecture)
3. [Repository Guide](#3-repository-guide)
4. [Scripts Reference](#4-scripts-reference)
5. [GitHub Actions Workflow](#5-github-actions-workflow)
6. [Google Sheet Setup](#6-google-sheet-setup)
7. [Looker Studio Report](#7-looker-studio-report)
8. [Enabling a New Repo](#8-enabling-a-new-repo)
9. [Secrets & Variables Reference](#9-secrets--variables-reference)
10. [Troubleshooting Guide](#10-troubleshooting-guide)
11. [Future Roadmap](#11-future-roadmap)

---

## 1. Background & Purpose

### What this system does

The DT Contribution Tracker automatically logs every PR's contribution data to a Google Sheet and visualises it in a Looker Studio dashboard. It was built to solve three specific problems:

| Problem                                                 | Impact                                             |
| ------------------------------------------------------- | -------------------------------------------------- |
| DT contribution data only visible inside each PR screen | Leaders must manually check every PR in every repo |
| Git squash by engineers wipes DT commit history         | Effort tracking permanently lost after merge       |
| No aggregate view across repos or branches              | Impossible to see overall DT handoff health        |

### How DT team works

1. **DT team** owns the UI component library (`@chargebee/ui-components` — separate npm package) and creates static UI templates (page shells, feature scaffolding) in the product repo
2. **Frontend engineers** receive DT templates via a feature branch, wire business logic and API calls on top, then merge to main
3. DT team never merges directly to main — all DT work arrives via feature branches that FE engineers merge

### What the tracker measures

When a PR is raised (FE branch → main), the tracker:

- Counts commits and lines authored by DT members vs frontend engineers
- Detects how many lines frontend engineers wrote on files DT originally authored (overwrite rate — measures handoff friction)
- Logs everything to Google Sheets before any squash can happen
- Posts a markdown summary as a PR comment

### The two key metrics

| Metric                | Formula                                      | What it means                                                    |
| --------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| **DT contribution %** | DT lines added / total lines added × 100     | How much of the code shipped was DT-authored                     |
| **Overwrite %**       | DEV lines on DT files / DT lines added × 100 | How much FE had to rework DT templates — lower = cleaner handoff |

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   GitHub Actions Runner (temporary VM)           │
│                                                                  │
│   ./repo/        ← chargebee-ui-v2 PR code + full git history  │
│   ./dt-tools/    ← scripts from cb-saravanakumarn/dt-tools      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
   report-output.txt            report-payload.json
   (markdown → PR comment)      (structured → Google Sheets)
              │                         │
              ▼                         ▼
   PR comment posted           raw_logs + raw_diffs tabs
                                        │
                                        ▼
                               Looker Studio dashboard
```

### How the runner works

GitHub spins up a fresh temporary VM for every workflow run. The `actions/checkout` step is a plain `git clone` — you can run it multiple times pointing at different repos, each landing in a different folder. When the job finishes the VM is destroyed. Nothing persists between runs.

### Opt-in model

Scripts are centralised in `dt-tools`. Enabling a new repo requires **one file only** — copy the YAML into `.github/workflows/`. No scripts, submodules, or dependencies go into the target repo.

---

## 3. Repository Guide

### `cb-saravanakumarn/dt-tools` (scripts repo)

```
dt-tools/
  scripts/
    dt-cb-git-contribution-tracker.js       ← analyses git log, writes both outputs
    dt-cb-git-contribution-push-to-sheets.js ← pushes JSON payload to Google Sheets
  README.md
```

**This is the single source of truth for all scripts.** Fix a bug here once — every enabled repo picks it up on the next PR run automatically.

- URL: `https://github.com/cb-saravanakumarn/dt-tools`
- Branch: `main`
- Access: needs `CI_GITHUB_READ_ONLY_TOKEN` to checkout from `chargebee` org runners

### `chargebee/chargebee-ui-v2` (product repo — currently enabled)

```
chargebee-ui-v2/
  .github/
    workflows/
      dt-cb-git-contribution-tracker.yml    ← the only file this repo needs
```

- URL: `https://github.com/chargebee/chargebee-ui-v2`
- Trigger: PRs targeting `dt/skills-test` branch
- Secrets: `GOOGLE_SHEETS_CREDENTIALS`, `GOOGLE_SHEET_ID` set at repo level
- Variables: `DT_MEMBERS`, `EXCLUDE_PATHS` set at repo level

---

## 4. Scripts Reference

### `dt-cb-git-contribution-tracker.js`

**Purpose:** Analyses git commits between base branch and HEAD. Writes two output files.

**Usage:**

```bash
node dt-cb-git-contribution-tracker.js \
  --base origin/dt/skills-test \
  --repo-dir /absolute/path/to/repo \
  --dry-run
```

**CLI arguments:**

| Argument     | Required | Description                                               |
| ------------ | -------- | --------------------------------------------------------- |
| `--base`     | Yes      | Base ref to diff against e.g. `origin/dt/skills-test`     |
| `--repo-dir` | Yes      | Absolute path to the checked-out PR repo                  |
| `--dry-run`  | No       | Wraps markdown output in `DRY RUN` markers for PR comment |

**Environment variables (injected by YAML):**

| Variable        | Source                               | Description                              |
| --------------- | ------------------------------------ | ---------------------------------------- |
| `GH_REPO`       | `github.repository`                  | e.g. `chargebee/chargebee-ui-v2`         |
| `GH_PR_NUMBER`  | `github.event.pull_request.number`   | PR number                                |
| `GH_PR_TITLE`   | `github.event.pull_request.title`    | PR title                                 |
| `GH_PR_URL`     | `github.event.pull_request.html_url` | Full PR URL                              |
| `GH_RUN_ID`     | `github.run_id`                      | Deduplication key                        |
| `DT_MEMBERS`    | `vars.DT_MEMBERS`                    | Comma-separated GitHub logins of DT team |
| `EXCLUDE_PATHS` | `vars.EXCLUDE_PATHS`                 | Comma-separated path prefixes to exclude |

**DT member detection (priority order):**

1. `DT_MEMBERS` env var — comma-separated GitHub logins
2. `.dt-members` file in repo root — one login per line
3. Falls back to treating ALL authors as DT if neither is set

**File exclusions (built-in — not tracked as contribution):**

- `.cursor/` — editor config
- `package.json`, `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` — dependency files
- `.gitignore`, `.env*` — repo config
- `plan.md`, `*.csv` — planning/data files
- Additional paths via `EXCLUDE_PATHS` variable

**Output files:**

`report-output.txt` — markdown report wrapped in `DRY RUN: Report preview` / `End of dry run` markers. Read by the PR comment step.

`report-payload.json` — structured JSON:

```json
{
  "timestamp": "2026-03-17T06:15:49Z",
  "repo": "chargebee/chargebee-ui-v2",
  "pr_number": "159",
  "pr_title": "Module/contract ingest",
  "pr_url": "https://github.com/chargebee/chargebee-ui-v2/pull/159",
  "base_branch": "dt/skills-test",
  "workflow_run_id": "23181160367",
  "diff_snapshot": "diff --git a/...(first 2000 chars)",
  "contributors": [
    {
      "author": "cb-saravanakumarn",
      "author_type": "DT",
      "commit_count": 4,
      "lines_added": 9,
      "lines_deleted": 6,
      "files_changed": 2,
      "commit_shas": ["e4238d5e", "5a942562"],
      "commit_dates": ["2026-03-17", "2026-03-16"],
      "commit_messages": ["fix: update page", "feat: add route"],
      "files_detail": [
        {
          "file": "src/pages/UnauthorizedPage.tsx",
          "dt_lines": 9,
          "dev_lines": 0,
          "total_lines": 9
        }
      ],
      "dt_files_touched": "src/pages/UnauthorizedPage.tsx",
      "dev_lines_on_dt_files": 0
    }
  ]
}
```

---

### `dt-cb-git-contribution-push-to-sheets.js`

**Purpose:** Reads `report-payload.json` and appends rows to Google Sheets.

**Usage:**

```bash
node dt-cb-git-contribution-push-to-sheets.js --payload report-payload.json
```

**Environment variables:**

| Variable                    | Description                           |
| --------------------------- | ------------------------------------- |
| `GOOGLE_SHEETS_CREDENTIALS` | Full contents of service account JSON |
| `GOOGLE_SHEET_ID`           | Sheet ID from the spreadsheet URL     |

**What it writes:**

- `raw_logs` tab — one row per author per PR (lean columns, Looker-facing)
- `raw_diffs` tab — one row per PR (heavy text: diff snapshot, file details, commit messages)

**Deduplication:** Checks `workflow_run_id` AND `repo + pr_number` combination before appending. Safe to re-run — won't create duplicates.

**Cell size safety:** Caps all text cells at 40,000 characters (Google Sheets limit is 50,000). Large PRs are truncated with a note rather than failing.

**DT member resolution:** Reads `dt_members` tab from the sheet first, falls back to `DT_MEMBERS` env var, then falls back to treating all authors as DT.

---

## 5. GitHub Actions Workflow

**File location in each enabled repo:**

```
.github/workflows/dt-cb-git-contribution-tracker.yml
```

**Trigger:** PRs opened, synchronised, or reopened against `dt/skills-test` branch.

### Step-by-step execution

| Step | Name                                   | What it does                                                                 |
| ---- | -------------------------------------- | ---------------------------------------------------------------------------- |
| 1    | Checkout code                          | Clones `chargebee-ui-v2` into `./repo/` with full history                    |
| 2    | Checkout dt-tools                      | Clones `cb-saravanakumarn/dt-tools` into `./dt-tools/`                       |
| 3    | Setup Node.js                          | Installs Node 20                                                             |
| 4    | Generate DT contribution report        | Runs tracker script → writes `report-output.txt` + `report-payload.json`     |
| 5    | Push contribution log to Google Sheets | Runs sheets script → appends rows (skipped if no payload or secrets missing) |
| 6    | Comment DT contribution report on PR   | Posts/updates markdown comment on the PR                                     |

### Important YAML flags

- `continue-on-error: true` on the Sheets step — large PRs or missing secrets never block the PR comment
- `|| true` on the tracker run command — script errors don't fail the step
- `fetch-depth: 0` on checkout — full git history required for `git log` to work

### Full YAML

```yaml
name: DT Contribution Tracker

on:
  pull_request:
    branches: [dt/skills-test]
    types: [opened, synchronize, reopened]
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write

jobs:
  dt-contribution:
    name: DT Contribution Report
    runs-on: cicd-medium-runner

    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          path: repo
          fetch-depth: 0
          submodules: recursive
          token: ${{ secrets.CI_GITHUB_READ_ONLY_TOKEN }}

      - name: Checkout dt-tools
        uses: actions/checkout@v4
        with:
          repository: cb-saravanakumarn/dt-tools
          ref: main
          path: dt-tools
          token: ${{ secrets.CI_GITHUB_READ_ONLY_TOKEN }}

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Generate DT contribution report
        id: report
        env:
          GH_REPO: ${{ github.repository }}
          GH_PR_NUMBER: ${{ github.event.pull_request.number }}
          GH_PR_TITLE: ${{ github.event.pull_request.title }}
          GH_PR_URL: ${{ github.event.pull_request.html_url }}
          GH_RUN_ID: ${{ github.run_id }}
          DT_MEMBERS: ${{ vars.DT_MEMBERS }}
          EXCLUDE_PATHS: ${{ vars.EXCLUDE_PATHS }}
        run: |
          echo "--- DEBUG ---"
          echo "Base ref   : ${{ github.base_ref }}"
          echo "Head ref   : ${{ github.head_ref }}"
          echo "PR number  : ${{ github.event.pull_request.number }}"
          echo "PR URL     : ${{ github.event.pull_request.html_url }}"
          echo "Event name : ${{ github.event_name }}"
          echo "HEAD commit: $(git -C repo rev-parse HEAD)"
          git -C repo fetch origin ${{ github.base_ref }}
          echo "Commits in range: $(git -C repo log origin/${{ github.base_ref }}..HEAD --oneline | wc -l)"
          echo "--- END DEBUG ---"

          REPO_DIR=${{ github.workspace }}/repo
          echo "REPO_DIR: $REPO_DIR"

          node dt-tools/scripts/dt-cb-git-contribution-tracker.js \
            --base origin/${{ github.base_ref }} \
            --repo-dir "$REPO_DIR" \
            --dry-run || true

          echo "--- report-output.txt content check ---"
          echo "File exists: $(test -f report-output.txt && echo YES || echo NO)"
          echo "File size: $(wc -c < report-output.txt 2>/dev/null || echo 0) bytes"
          echo "DRY RUN marker present: $(grep -c 'DRY RUN' report-output.txt 2>/dev/null || echo 0)"
          cat report-output.txt 2>/dev/null || echo "(no report-output.txt found)"

          if node -e "const p=JSON.parse(require('fs').readFileSync('report-payload.json','utf8')); process.exit(p.contributors && p.contributors.length > 0 ? 0 : 1)" 2>/dev/null; then
            echo "has_payload=true"  >> $GITHUB_OUTPUT
          else
            echo "has_payload=false" >> $GITHUB_OUTPUT
          fi

      - name: Push contribution log to Google Sheets
        if: steps.report.outputs.has_payload == 'true'
        continue-on-error: true
        env:
          GOOGLE_SHEETS_CREDENTIALS: ${{ secrets.GOOGLE_SHEETS_CREDENTIALS }}
          GOOGLE_SHEET_ID: ${{ secrets.GOOGLE_SHEET_ID }}
        run: |
          node dt-tools/scripts/dt-cb-git-contribution-push-to-sheets.js \
            --payload report-payload.json

      - name: Comment DT contribution report on PR
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            let output = '';
            try {
              output = fs.readFileSync('report-output.txt', 'utf8');
            } catch {
              console.log('No report output found, skipping.');
              return;
            }
            const lines    = output.split('\n');
            const startIdx = lines.findIndex(l => l.includes('DRY RUN: Report preview'));
            const endIdx   = lines.findIndex(l => l.includes('End of dry run'));
            if (startIdx === -1 || endIdx === -1) {
              console.log('No DT commits detected on this branch, skipping PR comment.');
              return;
            }
            const report = lines.slice(startIdx + 1, endIdx).join('\n').trim();
            if (!report) { console.log('Empty report, skipping.'); return; }
            const marker      = '<!-- dt-contribution-report -->';
            const commentBody = `${marker}\n\n${report}`;
            const { data: comments } = await github.rest.issues.listComments({
              owner: context.repo.owner, repo: context.repo.repo,
              issue_number: context.issue.number,
            });
            const existingComment = comments.find(c =>
              c.user.type === 'Bot' && c.body.includes(marker)
            );
            if (existingComment) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner, repo: context.repo.repo,
                comment_id: existingComment.id, body: commentBody,
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner, repo: context.repo.repo,
                issue_number: context.issue.number, body: commentBody,
              });
            }
```

---

## 6. Google Sheet Setup

**Spreadsheet name:** `DT Contribution Tracker`
**Access:** Share with service account email as Editor

### Tabs

| Tab           | Purpose                                             | Who reads it                      |
| ------------- | --------------------------------------------------- | --------------------------------- |
| `raw_logs`    | One row per author per PR — lean columns            | Looker Studio                     |
| `raw_diffs`   | One row per PR — heavy text (diff, files, messages) | AI layer (future)                 |
| `dt_members`  | DT team roster                                      | push-to-sheets.js + Looker Studio |
| `ai_analysis` | AI verdicts per PR — reserved for future            | AI layer (future)                 |

---

### `raw_logs` tab — column schema

Headers must be in row 1 **exactly in this order** (positional append):

| Col | Header                  | Type        | Example                           |
| --- | ----------------------- | ----------- | --------------------------------- |
| A   | `timestamp`             | Date & Time | `2026-03-17T06:15:49Z`            |
| B   | `repo`                  | Text        | `chargebee/chargebee-ui-v2`       |
| C   | `pr_number`             | Number      | `159`                             |
| D   | `pr_title`              | Text        | `Module/contract ingest`          |
| E   | `base_branch`           | Text        | `dt/skills-test`                  |
| F   | `feature_tag`           | Text        | `skills-test`                     |
| G   | `author`                | Text        | `cb-saravanakumarn`               |
| H   | `author_type`           | Text        | `DT` or `DEV`                     |
| I   | `commit_count`          | Number      | `4`                               |
| J   | `lines_added`           | Number      | `9`                               |
| K   | `lines_deleted`         | Number      | `6`                               |
| L   | `files_changed`         | Number      | `2`                               |
| M   | `commit_shas`           | Text        | `e4238d5e,5a942562`               |
| N   | `commit_dates`          | Text        | `2026-03-17,2026-03-16`           |
| O   | `dt_files_touched`      | Text        | `src/pages/UnauthorizedPage.tsx`  |
| P   | `dev_lines_on_dt_files` | Number      | `0`                               |
| Q   | `workflow_run_id`       | Text        | `23181160367`                     |
| R   | `pr_url`                | URL         | `https://github.com/.../pull/159` |

> **Warning:** Column order is critical. The script appends positionally. If you add/remove columns, update the script's `buildRows` function to match.

---

### `raw_diffs` tab — column schema

One row per PR (heavy text — not used by Looker):

| Col | Header            | Description                           |
| --- | ----------------- | ------------------------------------- |
| A   | `timestamp`       | Same as raw_logs                      |
| B   | `repo`            | Same as raw_logs                      |
| C   | `pr_number`       | Same as raw_logs                      |
| D   | `workflow_run_id` | Primary key — joins to raw_logs col Q |
| E   | `commit_messages` | All authors' messages, `\|` separated |
| F   | `files_detail`    | Per-file breakdown as JSON array      |
| G   | `diff_snapshot`   | First 2000 chars of diff              |

---

### `dt_members` tab — team roster

| Col | Header      | Description                                                         |
| --- | ----------- | ------------------------------------------------------------------- |
| A   | `login`     | GitHub username — must match `author` in raw_logs                   |
| B   | `name`      | Display name                                                        |
| C   | `joined_dt` | Date joined DT team                                                 |
| D   | `active`    | `TRUE` / `FALSE` — never delete rows, set FALSE when someone leaves |
| E   | `role`      | engineer / lead / qa etc.                                           |

> Populate with all DT team members. The push script reads this tab to resolve `author_type`. When someone leaves, set `active = FALSE` — historical rows remain unchanged.

---

### Google Cloud setup (one-time)

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create project `dt-contribution-tracker` (or reuse existing)
3. Enable: **APIs & Services → Google Sheets API**
4. Create service account: **Credentials → Service Account** → name `dt-sheets-writer`
5. Download JSON key: open service account → **Keys → Add Key → JSON**
6. Share the Google Sheet with the service account email (`client_email` in the JSON) as **Editor**

---

### Scalability

| Volume                           | Approach                                                        |
| -------------------------------- | --------------------------------------------------------------- |
| Small (1–2 repos, <10 PRs/day)   | Single sheet — safe for 3–5 years                               |
| Medium (5–10 repos)              | One sheet per year — Looker blends all sheets                   |
| Large (10+ repos, high velocity) | Migrate to BigQuery — schema identical, swap writer script only |

`raw_logs` stays lean (numeric/short-text only). Heavy columns (`diff_snapshot`, `files_detail`) live in `raw_diffs` only so Looker dashboards stay fast indefinitely.

---

## 7. Looker Studio Report

**URL:** _(add your Looker Studio report URL here)_
**Data source:** `DT Contribution Tracker` Google Sheet → `raw_logs` tab

### Pages

| Page                    | Audience      | Purpose                                                              |
| ----------------------- | ------------- | -------------------------------------------------------------------- |
| Executive Summary       | Leadership    | One-glance health score — 4 scorecards + repo bars + overwrite chart |
| Repo & Branch Breakdown | DT team leads | Detailed trend + per-branch friction analysis + PR drill-through     |

---

### Calculated fields

Add these in **Resource → Manage added data sources → Edit → Add a field:**

**DT contribution %**

```
Field name: DT contribution %
ROUND(
  SUM(CASE WHEN author_type = "DT" THEN lines_added ELSE 0 END)
  / NULLIF(SUM(lines_added), 0)
  * 100
, 1)
```

**DT lines**

```
Field name: DT lines
SUM(CASE WHEN author_type = "DT" THEN lines_added ELSE 0 END)
```

**DEV lines**

```
Field name: DEV lines
SUM(CASE WHEN author_type = "DEV" THEN lines_added ELSE 0 END)
```

**Overwrite %**

```
Field name: Overwrite %
ROUND(
  SUM(dev_lines_on_dt_files)
  / NULLIF(SUM(CASE WHEN author_type = "DT" THEN lines_added ELSE 0 END), 0)
  * 100
, 1)
```

**Repo health label**

```
Field name: Repo health label
CASE
  WHEN ROUND(SUM(CASE WHEN author_type="DT" THEN lines_added ELSE 0 END)/NULLIF(SUM(lines_added),0)*100,1) >= 70
    AND ROUND(SUM(dev_lines_on_dt_files)/NULLIF(SUM(CASE WHEN author_type="DT" THEN lines_added ELSE 0 END),0)*100,1) <= 15
  THEN "Healthy"
  WHEN ROUND(SUM(CASE WHEN author_type="DT" THEN lines_added ELSE 0 END)/NULLIF(SUM(lines_added),0)*100,1) < 50
    OR ROUND(SUM(dev_lines_on_dt_files)/NULLIF(SUM(CASE WHEN author_type="DT" THEN lines_added ELSE 0 END),0)*100,1) > 25
  THEN "Needs attention"
  ELSE "Review"
END
```

**Overwrite friction label** (for conditional text colour in tables)

```
Field name: Overwrite friction label
CASE
  WHEN ROUND(SUM(dev_lines_on_dt_files)/NULLIF(SUM(CASE WHEN author_type="DT" THEN lines_added ELSE 0 END),0)*100,1) > 25 THEN "High"
  WHEN ROUND(SUM(dev_lines_on_dt_files)/NULLIF(SUM(CASE WHEN author_type="DT" THEN lines_added ELSE 0 END),0)*100,1) > 15 THEN "Medium"
  ELSE "Low"
END
```

---

### Field type overrides

In the data source editor, set these manually:

| Field                   | Type        | Aggregation |
| ----------------------- | ----------- | ----------- |
| `timestamp`             | Date & Time | None        |
| `pr_number`             | Number      | None        |
| `commit_count`          | Number      | Sum         |
| `lines_added`           | Number      | Sum         |
| `lines_deleted`         | Number      | Sum         |
| `files_changed`         | Number      | Sum         |
| `dev_lines_on_dt_files` | Number      | Sum         |
| `pr_url`                | URL         | None        |
| `workflow_run_id`       | Text        | None        |

---

### Page 1 — Executive Summary

**Filters (top bar):**

- Date range control → linked to `timestamp`
- Filter control → field: `repo` → style: List (dropdown)

**Scorecard strip (4 cards):**

| Card | Metric                                  | Label             | Comparison      |
| ---- | --------------------------------------- | ----------------- | --------------- |
| 1    | `DT contribution %`                     | DT contribution   | Previous period |
| 2    | `Overwrite %`                           | Overwrite rate    | Previous period |
| 3    | `COUNT(pr_number)`                      | PRs tracked       | —               |
| 4    | `COUNT_DISTINCT(author)` filtered to DT | Active DT members | —               |

**DT vs DEV contribution by repo** (stacked bar chart):

- Dimension: `repo`
- Metric 1: `DT lines` → colour `#1D9E75`
- Metric 2: `DEV lines` → colour `#D3D1C7`
- Style: stacked bars ON, data labels ON

**Overwrite rate by branch** (table):

- Dimension: `feature_tag`
- Metrics: `Overwrite %`, `DT contribution %`, `COUNT(pr_number)`
- Sort: `Overwrite %` descending
- Style: heatmap on `Overwrite %` (min `#E1F5EE`, max `#FCEBEB`), heatmap on `DT contribution %` (inverted)

**Repo health table:**

- Dimensions: `repo`, `Repo health label`
- Metrics: `DT contribution %`, `Overwrite %`, `COUNT(pr_number)`

---

### Page 2 — Repo & Branch Breakdown

**Filters (top bar):**

- Date range control
- Filter control → `repo`
- Filter control → `feature_tag`

**Scorecards:** Same 4 as Page 1 (context changes with filters)

**DT contribution % over time** (time series):

- Dimension: `timestamp` → granularity: Week
- Metric: `DT contribution %`
- Breakdown: `repo`
- Style: line colour `#1D9E75`, Y-axis min `0` max `100`

**DT vs DEV lines per week** (bar chart):

- Dimension: `timestamp` → granularity: Week
- Metric 1: `DT lines` → `#1D9E75`
- Metric 2: `DEV lines` → `#D3D1C7`
- Style: stacked bars, data labels ON

**Overwrite rate by branch** (bar chart):

- Dimension: `feature_tag`
- Metric: `Overwrite %`
- Style: colour `#EF9F27`, Y-axis min `0` max `100`

**PR drill-through** (table):

- Dimensions: `timestamp`, `repo`, `feature_tag`, `pr_number`, `pr_title`, `author`, `author_type`, `pr_url`
- Metrics: `commit_count`, `lines_added`, `dev_lines_on_dt_files`
- Sort: `timestamp` descending
- Style: enable hyperlink on `pr_url` column

**Branch summary** (table):

- Dimension: `feature_tag`
- Metrics: `DT contribution %`, `Overwrite %`, `COUNT(pr_number)`, `Overwrite friction label`
- Sort: `Overwrite %` descending
- Style: heatmap on both % columns

---

### Theme & styling

| Property                   | Value        |
| -------------------------- | ------------ |
| Page background            | `#F6F6F3`    |
| Canvas / card background   | `#FFFFFF`    |
| Border colour              | `#D3D1C7`    |
| DT colour (positive)       | `#1D9E75`    |
| Overwrite colour (warning) | `#EF9F27`    |
| Friction colour (danger)   | `#E24B4A`    |
| Text primary               | `#2C2C2A`    |
| Text secondary             | `#888780`    |
| Canvas size                | 1200 × 900px |

---

## 8. Enabling a New Repo

To start tracking a new repository:

**Step 1 — Copy the YAML**

```
Copy .github/workflows/dt-cb-git-contribution-tracker.yml
into the target repo at the same path.

Update the trigger branch if needed:
  branches: [your-dt-branch-name]
```

**Step 2 — Add secrets to the new repo**

Go to: `github.com/chargebee/{repo-name}` → Settings → Secrets and variables → Actions

| Secret/Variable             | Value                                               |
| --------------------------- | --------------------------------------------------- |
| `GOOGLE_SHEETS_CREDENTIALS` | Same service account JSON used for other repos      |
| `GOOGLE_SHEET_ID`           | Same sheet ID (all repos log to same sheet)         |
| `DT_MEMBERS`                | Comma-separated DT team logins                      |
| `EXCLUDE_PATHS`             | Optional — paths to exclude e.g. `docs/,storybook/` |

> If secrets are already set at org level, skip Step 2 — they'll be inherited automatically.

**Step 3 — Open a test PR**

Create a branch with any small change and raise a PR targeting your DT branch. The workflow should trigger, post a PR comment, and log a row to the sheet.

**That's it.** No scripts to copy, no npm packages to install.

---

## 9. Secrets & Variables Reference

### GitHub Secrets (repo or org level)

| Name                        | Type   | Description                                                 | Where to get it                                                 |
| --------------------------- | ------ | ----------------------------------------------------------- | --------------------------------------------------------------- |
| `GOOGLE_SHEETS_CREDENTIALS` | Secret | Full JSON content of service account key file               | Google Cloud Console → IAM → Service Accounts → Keys            |
| `GOOGLE_SHEET_ID`           | Secret | ID from sheet URL: `.../spreadsheets/d/{ID}/edit`           | Google Sheets URL                                               |
| `CI_GITHUB_READ_ONLY_TOKEN` | Secret | PAT with read access to `chargebee` org and `dt-tools` repo | GitHub → Settings → Developer settings → Personal access tokens |

### GitHub Variables (repo or org level)

| Name            | Type     | Example                                   | Description                                                                |
| --------------- | -------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| `DT_MEMBERS`    | Variable | `cb-saravanakumarn,cb-vikram,cb-sathishu` | Comma-separated GitHub logins of DT team. Update when team changes.        |
| `EXCLUDE_PATHS` | Variable | `docs/,storybook/,.storybook/`            | Optional. Comma-separated path prefixes excluded from contribution counts. |

> Variables are plain text (not encrypted). Never put credentials in variables — use Secrets for those.

---

## 10. Troubleshooting Guide

### Workflow runs but no data in sheet

**Check:** Does the "Push contribution log" step show `has_payload=false`?

- Look at the "Generate DT contribution report" step logs
- If `[ANALYSE] commits=0 authors=0` — the git range found no commits. Verify the PR branch has commits on top of the base branch
- If `DT members loaded: 0` — `DT_MEMBERS` variable is not set or empty

**Check:** Does the step show `Sheets 400` error?

- Cell size exceeded — large PR. The `continue-on-error: true` flag means this won't fail the workflow. Check the truncation is working in the latest script version.

---

### PR comment not appearing

- Check "Comment DT contribution report on PR" step logs
- `No DT commits detected` — `report-output.txt` doesn't contain `DRY RUN: Report preview` marker
- `No report output found` — `report-output.txt` wasn't written at all (script crashed before writing)
- Check the workflow has `pull-requests: write` permission

---

### `author_type` showing wrong values

- All authors showing as `DT` → `DT_MEMBERS` variable is empty — script defaults to DT for everyone
- All authors showing as `DEV` → logins in `DT_MEMBERS` don't match git commit author logins exactly (case-sensitive)
- Check the script logs for `DT members loaded from DT_MEMBERS env (N): login1, login2`

---

### Duplicate rows in sheet

- Caused by workflow triggering on both `opened` and `synchronize` events for the same PR
- The deduplication logic checks `workflow_run_id` AND `repo + pr_number` — if you see duplicates, check which `workflow_run_id` values are present and manually delete the older set

---

### Schema mismatch in Looker Studio

**Error:** "Data Set Configuration Error — underlying data has changed"

Fix: Resource → Manage added data sources → Edit → Refresh fields → Done

If that doesn't fix it: Edit Connection → re-select `raw_logs` tab → Reconnect → Apply

**Cause:** This happens when sheet columns are added, removed, or reordered. The column order in `raw_logs` must exactly match the `buildRows` array in `push-to-sheets.js`.

---

### Adding a new DT team member

1. Add their GitHub login to `DT_MEMBERS` variable in GitHub (Settings → Variables → Actions)
2. Add a row to the `dt_members` tab in the Google Sheet
3. Historical rows won't change — new PRs will correctly attribute their work as DT going forward

---

### Removing a DT team member

1. Remove their login from `DT_MEMBERS` variable
2. In the `dt_members` sheet tab, set `active = FALSE` for their row — never delete the row
3. Historical contributions remain intact

---

## 11. Future Roadmap

### AI analysis layer (planned)

The schema is already designed to support AI-powered PR analysis. The `raw_diffs` tab stores the diff snapshot and per-file details needed for this.

**Planned capabilities:**

- Revert detection — flag PRs where changes undo previous DT work
- Duplicate diff detection — similarity scoring across PRs
- Code quality flags — PASS / WARN / FAIL per PR
- AI summary — one-sentence description of what each PR does

**How it plugs in:**

- New script `dt-cb-git-contribution-ai-analysis.js` reads `raw_diffs` tab
- Calls Claude/OpenAI API with diff content
- Writes verdicts to `ai_analysis` tab (already reserved in sheet)
- Looker Studio blends `raw_logs` + `ai_analysis` on `repo + pr_number + author`
- No changes needed to YAML, tracker script, or sheet schema

### Yearly archiving (when raw_logs hits ~40k rows)

1. Duplicate `raw_logs` tab → rename to `raw_logs_YYYY`
2. Clear `raw_logs` (keep headers)
3. In Looker: add `raw_logs_YYYY` as second data source → blend with current `raw_logs`
4. Repeat annually

---

## Appendix — Key URLs

| Resource             | URL                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| dt-tools repo        | `https://github.com/cb-saravanakumarn/dt-tools`                                                                               |
| chargebee-ui-v2 repo | `https://github.com/chargebee/chargebee-ui-v2`                                                                                |
| Google Sheet         | https://docs.google.com/spreadsheets/d/1oFj3KuSSfQRj2FEghK4NuD3XSHAg_NmGuFeHU8KmvrU/edit?gid=0#gid=0                          |
| Looker Studio report | https://lookerstudio.google.com/reporting/e16f17be-f8af-4260-8962-4ff5caed2e69/page/p_oejddiiv1d                              |
| Google Cloud project | https://console.cloud.google.com/iam-admin/serviceaccounts/details/113277746872939253077/keys?project=dt-contribution-tracker |

---

_Document maintained by DT team. Update the Appendix URLs before sharing with team members._
