#!/usr/bin/env node
// Run the gate over every frozen deliverable and fail on any drift.
//
// The unit tests do not catch control defects. Every defect found in these controls was found by
// running new work through them -- a Go handler the auth check could not read, a ConditionExpression
// held in a variable, a child module planned as a root, a vitest summary line counted as a test
// count -- while several hundred unit tests passed throughout. The tests check that a control does
// what it was written to do; only real projects show what it was written to do wrongly.
//
// Drift fails in BOTH directions. A control that stops firing is as much a regression as one that
// starts over-firing, and this project has shipped both: false positives that made a model rewrite
// working code, and a check that sat unspawned through ten graded runs while a similarly-named one
// ran beside it.
import { execFileSync } from "child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

/**
 * A finding's identity is the check that produced it. Message bodies carry counts, paths and prose
 * that move for reasons unrelated to whether the control still fires, so the corpus pins WHICH
 * checks fire and HOW MANY times rather than their wording. Pinning the prose would make every
 * improvement to a remediation message look like a regression, and the remediations have been
 * rewritten repeatedly -- one of them cost a run by naming a setting without naming the block it
 * belongs in.
 */
export function findingId(message) {
  const m = /^([a-z_][a-z_ ]*)\s*(?:\(|:)/i.exec(message.trim());
  return m ? m[1].trim() : message.trim().slice(0, 24);
}

function runGate(projectDir, taskFile) {
  const args = [path.join(REPO, "bin", "validate.mjs"), projectDir, taskFile, "--json"];
  let out;
  try {
    out = execFileSync("node", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    // A blocked project exits 1. That is the expected case for most of this corpus, so a non-zero
    // exit carries the result rather than signalling a failure to run.
    out = err.stdout;
    if (!out) throw new Error(`gate produced no output for ${projectDir}: ${err.message}`);
  }
  return JSON.parse(out);
}

function diffCounts(expected, actual) {
  const drift = [];
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const e = expected[key] || 0;
    const a = actual[key] || 0;
    if (e !== a) drift.push(`${key}: expected ${e}, got ${a}`);
  }
  return drift;
}

// The fixtures are sibling checkouts by default and can be pointed elsewhere, so a vendored or
// fetched copy satisfies the corpus without editing the manifest.
// The fixtures ship as one archive, extracted to scratch space for the run. Vendoring them as files
// put their deliberately vulnerable dependency manifests into this repository's own dependency scan
// and added fifteen Terraform roots to every pre-commit run; an archive is opaque to both.
// CORPUS_FIXTURES still points at a directory of unpacked fixtures, for anyone who wants that.
const ARCHIVE = path.join(__dirname, "fixtures.tar.gz");
let FIXTURE_ROOT = process.env.CORPUS_FIXTURES ? path.resolve(process.env.CORPUS_FIXTURES) : null;
let extracted = null;
if (!FIXTURE_ROOT) {
  if (existsSync(ARCHIVE)) {
    extracted = mkdtempSync(path.join(tmpdir(), "corpus-fixtures-"));
    execFileSync("tar", ["-xzf", ARCHIVE, "-C", extracted]);
    FIXTURE_ROOT = extracted;
  } else {
    FIXTURE_ROOT = REPO;
  }
}
process.on("exit", () => { if (extracted) rmSync(extracted, { recursive: true, force: true }); });

// --update re-derives the expected values instead of diffing against them. It is the same code path
// either way, deliberately: a separate script for re-deriving would prepare the fixtures slightly
// differently from the one that checks them, and then the corpus would be measuring something the
// runner never runs. That happened during this file's own development -- the re-derive script
// skipped the scratch copy and the git init, and every fixture read as drifted.
const UPDATE = process.argv.includes("--update");

const manifestPath = path.join(__dirname, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
console.log(`corpus: ${manifest.entries.length} deliverables${UPDATE ? " — RE-DERIVING expected values" : `, verdicts measured ${manifest.measured}`}\n`);

let failed = 0;
let missing = 0;
for (const entry of manifest.entries) {
  // Relative to the repository root, not to corpus/ — the fixtures are siblings of the repo.
  // From the archive the fixtures sit at their bare names; from a directory they sit where the
  // manifest says.
  const dir = extracted ? path.join(FIXTURE_ROOT, entry.name) : path.resolve(FIXTURE_ROOT, entry.path);
  const taskFile = path.resolve(REPO, entry.taskFile);
  if (!existsSync(dir)) {
    // Reported, never silently passed. A corpus that shrinks because fixtures went missing would
    // report green while checking less and less.
    console.log(`  MISSING  ${entry.name} — no such directory: ${dir}`);
    missing++;
    continue;
  }

  // The gate runs against a scratch copy, never the committed fixture. Two reasons, both learned
  // here: `terraform init` and `go build` write .terraform/, .terraform.lock.hcl and go.sum into
  // whatever tree they run in, which would leave version-controlled fixtures dirty after every
  // corpus run; and the uncommitted_work validator reads git state, so the fixture needs a
  // repository with everything committed -- which cannot live inside the fixture itself, because
  // `git add` would commit it as an embedded repository and a fresh clone would find nothing.
  const scratch = mkdtempSync(path.join(tmpdir(), "corpus-"));
  const work = path.join(scratch, entry.name);
  let r;
  try {
    cpSync(dir, work, { recursive: true });
    execFileSync("git", ["-C", work, "init", "-q"]);
    execFileSync("git", ["-C", work, "add", "-A"]);
    execFileSync("git", ["-C", work, "-c", "user.name=corpus", "-c", "user.email=corpus@localhost",
      "commit", "-q", "-m", "corpus fixture"]);
    r = runGate(work, taskFile);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const counts = {};
  for (const f of r.findings) counts[findingId(f.message)] = (counts[findingId(f.message)] || 0) + 1;
  if (UPDATE) {
    const wasBlocking = entry.expectedBlocking;
    entry.expectedBlocking = r.blocking;
    entry.expectedFindings = Object.fromEntries(Object.entries(counts).sort());

    // asDelivered is re-measured too, against the ORIGINAL, whenever it is on this machine.
    // Leaving it frozen while the vendored number is re-derived would let the two drift apart on any
    // control change, and the pair only means something if both were measured under the same gate.
    const upstream = entry.upstream ? path.resolve(REPO, entry.upstream) : null;
    if (upstream && existsSync(upstream)) {
      const u = runGate(upstream, taskFile);
      entry.asDelivered = u.blocking;
      entry.asDeliveredMeasured = "against the original deliverable, same gate";
    } else if (typeof entry.asDelivered === "number") {
      entry.asDeliveredStale = "the original was not on this machine when the vendored number was re-derived; this figure is from an earlier gate";
    }
    if (entry.asDelivered !== entry.expectedBlocking) {
      entry.differsFromAsDelivered =
        `the vendored copy scores ${entry.expectedBlocking} where the original scores ${entry.asDelivered}, ` +
        `because node_modules is not vendored: the suite cannot run, so the tests check fires`;
    } else {
      delete entry.differsFromAsDelivered;
      delete entry.asDeliveredStale;
    }
    console.log(`  recorded ${entry.name}  ${wasBlocking} -> ${r.blocking}${entry.asDelivered !== r.blocking ? `  (as delivered: ${entry.asDelivered})` : ""}`);
    continue;
  }

  const drift = diffCounts(entry.expectedFindings, counts);

  // A control that could not run makes the verdict meaningless, so it fails regardless of counts.
  if (r.incomplete) {
    console.log(`  INCOMPLETE ${entry.name} — a control could not run; this verdict proves nothing`);
    for (const c of r.controls.filter((c) => c.status !== "ran")) console.log(`      ${c.name}: ${c.error || "never called"}`);
    failed++;
  } else if (r.blocking !== entry.expectedBlocking || drift.length) {
    console.log(`  DRIFT    ${entry.name} — blocking ${entry.expectedBlocking} -> ${r.blocking}`);
    for (const d of drift) console.log(`      ${d}`);
    failed++;
  } else {
    // Both numbers on the line. Four of eleven fixtures score differently vendored than delivered,
    // and a scoreboard on which the clean projects read as 1 invites exactly one question -- the
    // answer to which should not be a footnote in a manifest nobody opens.
    const delivered =
      typeof entry.asDelivered === "number" && entry.asDelivered !== r.blocking
        ? `; ${entry.asDelivered} as delivered — the suite cannot run without node_modules`
        : "";
    console.log(`  ok       ${entry.name}  (${r.blocking} blocking${delivered})`);
  }
}

if (UPDATE) {
  manifest.measured = new Date().toISOString().slice(0, 10);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nre-derived ${manifest.entries.length} verdicts into corpus/manifest.json`);
  process.exit(0);
}

console.log("");

// Exit 3, not 1, and not 0. A corpus that cannot find its fixtures did not run, and that is a
// different fact from a corpus that ran and found drift -- the same distinction the gate itself
// draws between "blocking findings" and "part of the gate could not run". Reporting it as a pass
// is the failure this whole project exists to remove, and it was sitting in this repo's own
// workflow: a guard that exited 0 with a warning when the fixtures were absent.
if (missing) {
  console.log(`${missing} of ${manifest.entries.length} fixture(s) are not present — THE CORPUS DID NOT RUN.`);
  console.log(`Set CORPUS_FIXTURES to the directory holding them, or check them out beside this repo.`);
  console.log(`This is not a pass: nothing was verified about the ${missing} that are missing.`);
  process.exit(3);
}
if (failed) {
  console.log(`${failed} deliverable(s) drifted.`);
  console.log("A control that stops firing is as much a regression as one that starts over-firing.");
  console.log("If the change was deliberate, re-derive corpus/manifest.json and say so in the commit.");
  process.exit(1);
}
console.log(`all ${manifest.entries.length} deliverables match.`);
