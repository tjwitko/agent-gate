#!/usr/bin/env node
// The calibration corpus: the sast rules against real applications whose answers are known.
//
//   node calibration/run.mjs                 compare against calibration/manifest.json
//   node calibration/run.mjs --update        re-measure and freeze what was measured
//   node calibration/run.mjs --only=a,b      just those apps
//   node calibration/run.mjs --shard=2/4     the second of four parts, for parallel CI jobs
//
// The regression corpus (corpus/) holds deliverables this project produced and checks every verdict
// the gate gives them. This holds other people's code and checks one validator, sast, at the level
// it can be wrong: per rule. Two kinds of app, and both matter:
//
//   - deliberately vulnerable ones (WebGoat, RailsGoat, Juice Shop, PyGoat, dvcsharp-api), where a
//     rule that stops finding the documented injection has broken;
//   - real ones with no known injection (PetClinic, Mastodon, Gitea, curl, ...), where a rule that
//     starts blocking is a false positive on code people ship. Every rule this project has written
//     was first measured this way, and the first pass of each had false positives only real code
//     showed: 31 on Bitwarden from services whose methods are named like HTTP calls, 28 path
//     traversals on agent-gate from `import.meta.url`.
//
// Nothing here copies those apps into this repository. The manifest holds each one's URL and full
// commit SHA, and this clones exactly that commit, shallow, scans it, and deletes it. Copying would
// trip push protection on their test credentials, fire this repository's own gate on their code, and
// bring their licences with it (Mastodon is AGPL).
//
// SCAN ONLY. The gate itself is not run on these: it executes a project's test suite, and nothing
// here builds, installs or runs any of this code. Only the sast validator is called, in-process, on
// the files as checked out -- with git hooks off and LFS smudging off, so a checkout runs nothing
// either.
//
// Counts are frozen per app and per rule ID, blocking and advisory, as measured at the pinned SHA
// with the pinned semgrep. A different semgrep is not compared at all: its counts would differ for
// reasons that are not a rule change, and that difference is exactly what reads as one.
//
// Exit: 0 every app matches, 1 a count moved, 3 something could not be measured.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

import { sastScan } from "../agent/sast.mjs";
import { toolchain, toolchainDrift } from "../lib/toolchain.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// --manifest= is for testing the runner against a copy; CI uses the committed one.
const MANIFEST = path.resolve((process.argv.find((a) => a.startsWith("--manifest=")) || "").slice("--manifest=".length) || path.join(__dirname, "manifest.json"));
const UPDATE = process.argv.includes("--update");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice("--only=".length).split(",").filter(Boolean);
const SHARD = /^--shard=(\d+)\/(\d+)$/.exec(process.argv.find((a) => a.startsWith("--shard=")) || "");
const EXIT = { MATCH: 0, DRIFT: 1, INCOMPLETE: 3 };

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

// Parallel CI jobs, because one job does not fit: measured on the development machine, Mastodon alone
// took twelve minutes and the whole set over an hour. Apps are dealt largest first to the part with
// the fewest files so far, which is deterministic and keeps the parts close in size.
function shardOf(apps, k, n) {
  const parts = Array.from({ length: n }, () => ({ files: 0, names: new Set() }));
  for (const a of [...apps].sort((x, y) => (y.expected?.files ?? 0) - (x.expected?.files ?? 0) || x.name.localeCompare(y.name))) {
    const p = parts.reduce((min, q) => (q.files < min.files ? q : min));
    p.files += a.expected?.files ?? 0;
    p.names.add(a.name);
  }
  return parts[k - 1].names;
}
if (SHARD && (Number(SHARD[1]) < 1 || Number(SHARD[1]) > Number(SHARD[2]))) {
  console.error(`calibration: --shard=${SHARD[1]}/${SHARD[2]} names no part`);
  process.exit(2);
}
const selected = SHARD ? shardOf(manifest.apps, Number(SHARD[1]), Number(SHARD[2])) : null;
const wanted = (name) => (!ONLY.length || ONLY.includes(name)) && (!selected || selected.has(name));
// A selection that matches nothing would compare nothing and report "all 0 apps match".
if (!manifest.apps.some((a) => wanted(a.name))) {
  console.error(`calibration: ${ONLY.length ? `--only=${ONLY.join(",")}` : "the selection"} names no app in the manifest`);
  process.exit(2);
}
const current = await toolchain();

console.log(`calibration: ${manifest.apps.filter((a) => wanted(a.name)).length} of ${manifest.apps.length} apps${SHARD ? ` (part ${SHARD[1]} of ${SHARD[2]})` : ""}, semgrep pinned at ${manifest.semgrep}${UPDATE ? " — RE-MEASURING" : `, counts measured ${manifest.measured}`}`);
if (current.semgrep !== manifest.semgrep) {
  console.log(`\n  semgrep here is ${current.semgrep ?? "not installed"}, and these counts were measured with ${manifest.semgrep}.`);
  console.log(`  Nothing is compared: a different engine moves counts for reasons that are not a rule change.`);
  console.log(`  Install semgrep ${manifest.semgrep}, or move the pin deliberately and re-measure with --update.`);
  process.exit(EXIT.INCOMPLETE);
}
if (!UPDATE) {
  const drift = toolchainDrift(manifest.toolchain, current).filter((d) => !d.startsWith("semgrep"));
  if (drift.length) {
    console.log(`  the rest of the toolchain differs from what measured these (sast uses only semgrep and node):`);
    for (const d of drift) console.log(`    ${d}`);
  }
}
console.log("");

/** Clone exactly one commit, shallow, into a fresh directory. Runs nothing from the repository. */
function checkout(repo, commit) {
  const dir = mkdtempSync(path.join(tmpdir(), "calibration-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "advice.detachedHead=false", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" },
      timeout: 600_000,
    });
  try {
    git("init", "-q");
    git("fetch", "-q", "--depth", "1", "--no-tags", repo, commit);
    git("checkout", "-q", "FETCH_HEAD");
    return { dir };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    return { error: (err.stderr ? String(err.stderr) : err.message).trim().split("\n").pop() };
  }
}

function count(scan) {
  const byRule = {};
  for (const f of scan.findings) {
    byRule[f.rule] ||= { blocking: 0, advisory: 0 };
    byRule[f.rule][f.blocking ? "blocking" : "advisory"]++;
  }
  const sorted = Object.fromEntries(Object.entries(byRule).sort(([a], [b]) => a.localeCompare(b)));
  return {
    files: scan.files,
    blocking: scan.findings.filter((f) => f.blocking).length,
    advisory: scan.findings.filter((f) => !f.blocking).length,
    byRule: sorted,
  };
}

/** Every difference between what was frozen and what was measured, as sentences. */
function differences(want, got) {
  const out = [];
  if (want.files !== got.files) out.push(`files scanned ${want.files} -> ${got.files}`);
  for (const rule of new Set([...Object.keys(want.byRule), ...Object.keys(got.byRule)])) {
    for (const kind of ["blocking", "advisory"]) {
      const a = want.byRule[rule]?.[kind] ?? 0;
      const b = got.byRule[rule]?.[kind] ?? 0;
      if (a !== b) out.push(`${rule} ${kind} ${a} -> ${b}`);
    }
  }
  return out;
}

let drifted = 0;
let incomplete = 0;
const findingsAt = {};
for (const app of manifest.apps) {
  if (!wanted(app.name)) continue;
  const started = Date.now();
  const co = checkout(app.repo, app.commit);
  if (co.error) {
    console.log(`  INCOMPLETE ${app.name} — could not fetch ${app.commit.slice(0, 12)}: ${co.error}`);
    incomplete++;
    continue;
  }
  let scan;
  try {
    scan = sastScan(co.dir);
  } finally {
    rmSync(co.dir, { recursive: true, force: true });
  }
  const secs = `${Math.round((Date.now() - started) / 1000)}s`;
  if (scan.couldNotRun) {
    console.log(`  INCOMPLETE ${app.name} — ${scan.couldNotRun.join("; ")}`);
    incomplete++;
    continue;
  }
  const got = count(scan);
  findingsAt[app.name] = scan.findings.filter((f) => f.blocking).map((f) => `${f.rule} ${f.at}`);
  if (UPDATE) {
    app.expected = got;
    console.log(`  measured ${app.name}  ${got.files} files, ${got.blocking} blocking, ${got.advisory} advisory  (${secs})`);
    for (const b of findingsAt[app.name]) console.log(`      BLOCK ${b}`);
    continue;
  }
  const diff = differences(app.expected, got);
  if (diff.length) {
    drifted++;
    console.log(`  DRIFT    ${app.name}  blocking ${app.expected.blocking} -> ${got.blocking}, advisory ${app.expected.advisory} -> ${got.advisory}  (${secs})`);
    for (const d of diff) console.log(`      ${d}`);
    for (const b of findingsAt[app.name]) console.log(`      now blocking: ${b}`);
  } else {
    console.log(`  ok       ${app.name}  (${got.blocking} blocking, ${got.advisory} advisory, ${got.files} files, ${secs})`);
  }
}

if (UPDATE) {
  if (incomplete) {
    console.log(`\n${incomplete} app(s) could not be measured; the manifest was NOT written.`);
    process.exit(EXIT.INCOMPLETE);
  }
  manifest.measured = new Date().toISOString().slice(0, 10);
  manifest.toolchain = current;
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nwrote ${path.relative(process.cwd(), MANIFEST)}`);
  process.exit(EXIT.MATCH);
}

console.log("");
if (incomplete) {
  console.log(`${incomplete} app(s) could not be measured. That is not a match: nothing was compared for them.`);
  process.exit(EXIT.INCOMPLETE);
}
if (drifted) {
  console.log(`${drifted} app(s) drifted. A rule that stops finding a documented vulnerability has broken; one that`);
  console.log(`starts blocking real code is a false positive. If the change is deliberate, re-measure with --update`);
  console.log(`and say in the commit which counts moved and why.`);
  process.exit(EXIT.DRIFT);
}
console.log(`all ${manifest.apps.filter((a) => wanted(a.name)).length} apps match.`);
