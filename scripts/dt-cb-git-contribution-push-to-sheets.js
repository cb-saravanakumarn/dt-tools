/**
 * dt-cb-git-contribution-push-to-sheets.js
 *
 * Reads the JSON payload from dt-contribution-tracker.js (--output json)
 * and appends one row per author to the Google Sheet raw_logs tab.
 *
 * Metrics supported:
 *  - % file DT contribution   (via files_detail JSON)
 *  - % branch contribution    (via lines_added + author_type)
 *  - % repo contribution      (via repo + lines_added + author_type)
 *  - % overwrites on DT work  (via dt_files_touched + dev_lines_on_dt_files)
 *
 * DT member detection: reads dt_members tab from the same sheet.
 * Falls back to DT_MEMBERS env var if tab is empty or unreachable.
 *
 * Usage:
 *   node push-to-sheets.js --payload report-payload.json
 */

const fs = require("fs");
const https = require("https");
const { createSign } = require("crypto");

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const payloadFlag = args.indexOf("--payload");
if (payloadFlag === -1 || !args[payloadFlag + 1]) {
  console.error("Usage: node push-to-sheets.js --payload <path>");
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(args[payloadFlag + 1], "utf8"));
} catch (err) {
  console.error(`Failed to read payload: ${err.message}`);
  process.exit(1);
}

// ─── Env ─────────────────────────────────────────────────────────────────────
const credsRaw = process.env.GOOGLE_SHEETS_CREDENTIALS;
const sheetId = process.env.GOOGLE_SHEET_ID;
// Optional fallback: comma-separated DT logins e.g. "alice,bob,carol"
const dtMembersEnv = (process.env.DT_MEMBERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!credsRaw || !sheetId) {
  console.error("Missing GOOGLE_SHEETS_CREDENTIALS or GOOGLE_SHEET_ID");
  process.exit(1);
}

let creds;
try {
  creds = JSON.parse(credsRaw);
} catch {
  console.error("GOOGLE_SHEETS_CREDENTIALS is not valid JSON");
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function deriveFeatureTag(branch = "") {
  const parts = branch.split("/");
  return parts[parts.length - 1] || branch;
}

// ─── Google Auth (no-SDK JWT) ─────────────────────────────────────────────────
async function getAccessToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(claim));
  const msg = `${header}.${body}`;
  const sign = createSign("RSA-SHA256");
  sign.update(msg);
  const jwt = `${msg}.${base64url(sign.sign(creds.private_key))}`;
  const post = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "oauth2.googleapis.com",
        path: "/token",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            const p = JSON.parse(d);
            p.access_token
              ? resolve(p.access_token)
              : reject(new Error(`Auth failed: ${d}`));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(post);
    req.end();
  });
}

// ─── Sheets API helpers ────────────────────────────────────────────────────────
function sheetsGet(token, sheetId, range) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "sheets.googleapis.com",
        path: `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function sheetsAppend(token, sheetId, range, values) {
  const body = JSON.stringify({ values });
  const path =
    `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "sheets.googleapis.com",
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          res.statusCode >= 200 && res.statusCode < 300
            ? resolve(JSON.parse(d))
            : reject(new Error(`Sheets ${res.statusCode}: ${d}`));
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Load DT members from dt_members tab ─────────────────────────────────────
// Returns a Set of GitHub logins who are active DT members.
// Falls back to DT_MEMBERS env var if tab is missing or empty.
async function loadDtMembers(token, sheetId) {
  try {
    const res = await sheetsGet(token, sheetId, "dt_members!A:D");
    const rows = (res.values || []).slice(1); // skip header row
    const members = new Set(
      rows
        .filter((r) => r[3] !== "FALSE") // col D = active; skip inactive
        .map((r) => (r[0] || "").trim().toLowerCase())
        .filter(Boolean),
    );
    if (members.size > 0) {
      console.log(`Loaded ${members.size} DT members from sheet tab.`);
      return members;
    }
  } catch (e) {
    console.warn(`Could not read dt_members tab: ${e.message}`);
  }
  // Fallback to env var
  if (dtMembersEnv.length > 0) {
    console.log(
      `Using DT_MEMBERS env var fallback (${dtMembersEnv.length} members).`,
    );
    return new Set(dtMembersEnv.map((m) => m.toLowerCase()));
  }
  console.warn(
    'No DT member list found. author_type will default to "DT" for all authors.',
  );
  return new Set();
}

// ─── Overwrite detection ──────────────────────────────────────────────────────
// For each DEV author row: count lines they added in files that DT authors
// touched in the same PR. This is the "overwrite on DT work" signal.
function computeOverwrites(contributors) {
  // Build set of files touched by DT authors in this PR
  const dtFilesSet = new Set();
  for (const c of contributors) {
    if (c.author_type === "DT") {
      for (const f of c.files_detail || []) {
        dtFilesSet.add(f.file);
      }
    }
  }

  // For each author, compute:
  //   dt_files_touched     — which of their files overlap with dtFilesSet
  //   dev_lines_on_dt_files — if DEV, how many lines they added on DT files
  return contributors.map((c) => {
    const myFiles = (c.files_detail || []).map((f) => f.file);
    const dtOverlap = myFiles.filter((f) => dtFilesSet.has(f));
    const devLinesOnDt =
      c.author_type === "DEV"
        ? (c.files_detail || [])
            .filter((f) => dtFilesSet.has(f.file))
            .reduce((sum, f) => sum + (f.total_lines || 0), 0)
        : 0;
    return {
      ...c,
      dt_files_touched: dtOverlap.join(","),
      dev_lines_on_dt_files: devLinesOnDt,
    };
  });
}

// ─── Build sheet rows ─────────────────────────────────────────────────────────
// Returns { logRows, diffRows }
// logRows  → raw_logs tab  (lean, Looker-facing, no large-text cells)
// diffRows → raw_diffs tab (heavy text, AI-layer-facing, one row per PR)
function buildRows(payload, dtMembers) {
  const {
    repo,
    pr_number,
    pr_title,
    base_branch,
    pr_url,
    workflow_run_id,
    timestamp,
    diff_snapshot = "",
    contributors = [],
  } = payload;

  const featureTag = deriveFeatureTag(base_branch);
  const ts = timestamp || new Date().toISOString();

  const resolved = contributors.map((c) => ({
    ...c,
    author_type:
      c.author_type ||
      (dtMembers.size === 0
        ? "DT"
        : dtMembers.has((c.author || "").toLowerCase())
          ? "DT"
          : "DEV"),
  }));

  const withOverwrites = computeOverwrites(resolved);

  // ── raw_logs rows (one per author — lean columns only) ────────────────────
  const logRows = withOverwrites.map((c) => [
    ts, // A  timestamp
    repo, // B  repo
    pr_number, // C  pr_number
    pr_title, // D  pr_title
    base_branch, // E  base_branch
    featureTag, // F  feature_tag
    c.author, // G  author
    c.author_type, // H  author_type
    c.commit_count, // I  commit_count
    c.lines_added, // J  lines_added
    c.lines_deleted, // K  lines_deleted
    c.files_changed, // L  files_changed
    (c.commit_shas || []).join(","), // M  commit_shas
    (c.commit_dates || []).join(","), // N  commit_dates
    c.dt_files_touched, // O  dt_files_touched
    c.dev_lines_on_dt_files, // P  dev_lines_on_dt_files
    workflow_run_id, // Q  workflow_run_id (FK to raw_diffs)
    pr_url, // R  pr_url
  ]);

  // ── raw_diffs row (one per PR — heavy text, linked by workflow_run_id) ────
  // commit_messages and files_detail live here, not in raw_logs
  const allCommitMessages = withOverwrites
    .flatMap((c) => c.commit_messages || [])
    .filter((v, i, a) => a.indexOf(v) === i) // deduplicate
    .join(" | ");

  const allFilesDetail = withOverwrites.flatMap((c) => c.files_detail || []);

  const diffRows = [
    [
      ts, // A  timestamp
      repo, // B  repo
      pr_number, // C  pr_number
      workflow_run_id, // D  workflow_run_id (PK)
      allCommitMessages, // E  commit_messages (all authors)
      JSON.stringify(allFilesDetail), // F  files_detail (all authors, JSON)
      diff_snapshot.slice(0, 2000), // G  diff_snapshot
    ],
  ];

  return { logRows, diffRows };
}

// ─── Deduplication ────────────────────────────────────────────────────────────
async function isDuplicate(token, sheetId, runId) {
  if (!runId) return false;
  try {
    const res = await sheetsGet(token, sheetId, "raw_logs!T:T"); // workflow_run_id col
    const vals = (res.values || []).flat();
    return vals.includes(String(runId));
  } catch {
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.log("Authenticating with Google…");
    const token = await getAccessToken(creds);

    const alreadyLogged = await isDuplicate(
      token,
      sheetId,
      payload.workflow_run_id,
    );
    if (alreadyLogged) {
      console.log(
        `workflow_run_id ${payload.workflow_run_id} already logged. Skipping.`,
      );
      process.exit(0);
    }

    console.log("Loading DT member list…");
    const dtMembers = await loadDtMembers(token, sheetId);

    const { logRows, diffRows } = buildRows(payload, dtMembers);
    if (logRows.length === 0) {
      console.log("No contributor rows to append. Skipping.");
      process.exit(0);
    }

    console.log(`Appending ${logRows.length} row(s) to raw_logs…`);
    const r1 = await sheetsAppend(token, sheetId, "raw_logs!A:R", logRows);
    console.log(`raw_logs updated: ${r1.updates?.updatedRange}`);

    console.log("Appending 1 row to raw_diffs…");
    const r2 = await sheetsAppend(token, sheetId, "raw_diffs!A:G", diffRows);
    console.log(`raw_diffs updated: ${r2.updates?.updatedRange}`);
  } catch (err) {
    console.error("push-to-sheets failed:", err.message);
    process.exit(1);
  }
})();
