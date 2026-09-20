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
import { execFileSync, spawnSync } from "child_process";
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
  try {
    return JSON.parse(out);
  } catch (err) {
    // A raw SyntaxError here points at whatever leaked onto stdout and says nothing about which
    // fixture was being measured or that the corpus stopped early. The first CI run ended this way
    // on fixture five of eleven, and the traceback read as a corpus bug rather than as a narration
    // line in front of the document.
    const head = out.slice(0, 200).replace(/\n/g, "\\n");
    throw new Error(
      `the gate's --json output for ${projectDir} is not JSON (${err.message}).\n` +
        `stdout began: ${head}\n` +
        "In --json mode stdout must carry only the result document; something wrote to it."
    );
  }
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

// What measured these numbers, not just when. The manifest recorded a `measured` date and nothing
// else, and that gap hid a real defect for three fixtures: this machine had no Go toolchain, so
// `go test` never ran, the tests check reported NOT EXECUTED as an advisory, and the corpus froze
// that non-answer as the expected verdict. Their suites had never compiled. A run on a machine
// that HAD Go found it immediately -- and read as a regression in the control rather than as the
// deliverable defect it was.
//
// A null here is the interesting value, not a missing one: it means the corpus was derived on a
// machine that could not run that language's checks at all.
function toolchain() {
  const probe = (cmd, args, re) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    if (r.error || r.status === null) return null;
    const m = re.exec(`${r.stdout || ""}${r.stderr || ""}`);
    return m ? m[1] : null;
  };
  return {
    node: process.version.replace(/^v/, ""),
    go: probe("go", ["version"], /go(\d+\.\d+(?:\.\d+)?)/),
    terraform: probe("terraform", ["version"], /Terraform v(\d+\.\d+\.\d+)/),
    gitleaks: probe("gitleaks", ["version"], /(\d+\.\d+\.\d+)/),
    "osv-scanner": probe("osv-scanner", ["--version"], /(\d+\.\d+\.\d+)/),
    checkov: probe("checkov", ["--version"], /(\d+\.\d+\.\d+)/),
    python3: probe("python3", ["--version"], /(\d+\.\d+\.\d+)/),
    ruff: probe("ruff", ["--version"], /(\d+\.\d+\.\d+)/),
    docker: probe("docker", ["--version"], /(\d+\.\d+\.\d+)/),
  };
}

/** Differences between the toolchain that measured the manifest and the one running now. */
function toolchainDrift(recorded, current) {
  if (!recorded) return [];
  const out = [];
  for (const [name, was] of Object.entries(recorded)) {
    const now = current[name] ?? null;
    if (was === now) continue;
    if (was && !now) out.push(`${name}: recorded ${was}, ABSENT here — checks needing it cannot run`);
    else if (!was && now) out.push(`${name}: absent when recorded, ${now} here — checks that never ran then will run now`);
    else out.push(`${name}: recorded ${was}, ${now} here`);
  }
  return out;
}


const manifestPath = path.join(__dirname, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
console.log(`corpus: ${manifest.entries.length} deliverables${UPDATE ? " — RE-DERIVING expected values" : `, verdicts measured ${manifest.measured}`}\n`);

const CURRENT_TOOLCHAIN = toolchain();
if (!UPDATE) {
  const drift = toolchainDrift(manifest.toolchain, CURRENT_TOOLCHAIN);
  if (drift.length) {
    console.log(`  the toolchain differs from the one that measured these verdicts:`);
    for (const d of drift) console.log(`    ${d}`);
    console.log(`  counts are compared against scanners, not against source alone, so a difference`);
    console.log(`  here can look exactly like a control that changed behaviour.\n`);
  }
  if (!manifest.toolchain) {
    console.log(`  this manifest records no toolchain, so nothing can be said about what measured it.\n`);
  }
}

let failed = 0;
let missing = 0;
let unmeasured = 0;
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
    // An incomplete run measured nothing worth freezing. Recording it anyway is how three Go
    // fixtures came to carry a clean `tests` verdict from a machine with no Go toolchain: the
    // check honestly said NOT EXECUTED, and the corpus wrote that down as the answer. Expectations
    // are left exactly as they were and the entry is marked, so the gap is visible on every run
    // instead of looking like a measurement.
    if (r.incomplete) {
      entry.unmeasured = {
        on: new Date().toISOString().slice(0, 10),
        why: (r.couldNotRun || []).concat((r.unreachable || []).map((u) => `${u.name}: ${u.why}`)),
      };
      console.log(`  SKIPPED  ${entry.name} — the run was INCOMPLETE, expectations left unchanged`);
      for (const w of entry.unmeasured.why) console.log(`      ${w}`);
      unmeasured++;
      continue;
    }
    delete entry.unmeasured;
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

  // Expectations that were never measured are not a baseline, so there is nothing to compare
  // against and no verdict to print. This returns rather than falling through deliberately: the
  // first version printed UNMEASURED and then `ok (0 blocking)` for the same fixture, one line
  // apart, which is the mixed message the whole exercise is about.
  if (entry.unmeasured) {
    console.log(`  UNMEASURED ${entry.name} — its expectations were never measured (${entry.unmeasured.on})`);
    for (const w of entry.unmeasured.why) console.log(`      ${w}`);
    console.log(`      Nothing is compared for this fixture; matching it would confirm nothing.`);
    unmeasured++;
    continue;
  }

  // A control that could not run makes the verdict meaningless, so it fails regardless of counts.
  if (r.incomplete) {
    console.log(`  INCOMPLETE ${entry.name} — a control could not run; this verdict proves nothing`);
    for (const c of r.controls.filter((c) => c.status !== "ran")) console.log(`      ${c.name}: ${c.error || "never called"}`);
    failed++;
  } else if (r.blocking !== entry.expectedBlocking || drift.length) {
    console.log(`  DRIFT    ${entry.name} — blocking ${entry.expectedBlocking} -> ${r.blocking}`);
    for (const d of drift) console.log(`      ${d}`);
    // The counts say WHICH check moved; they never say why, and on a machine that is not this one
    // that is the whole question. Four fixtures drifted on the first CI run with `build_check:
    // expected 0, got 1` and nothing else to go on -- the message was sitting in the result
    // document the whole time. Printing it costs nothing on a green run, because there is no drift
    // to print.
    for (const f of r.findings) {
      if (drift.some((d) => d.startsWith(`${findingId(f.message)}:`))) {
        console.log(`        ${f.message.replace(/\n/g, "\n        ")}`);
      }
    }
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
  manifest.toolchain = CURRENT_TOOLCHAIN;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const absent = Object.entries(CURRENT_TOOLCHAIN).filter(([, v]) => v === null).map(([k]) => k);
  console.log(`\nre-derived ${manifest.entries.length - unmeasured} verdicts into corpus/manifest.json`);
  if (absent.length) {
    console.log(`  NOT INSTALLED HERE: ${absent.join(", ")} — any check needing one of these measured nothing.`);
  }
  if (unmeasured) {
    // Exit 3, matching the gate: part of this did not run. A re-derive that silently left some
    // entries un-re-derived would be the same defect one level up.
    console.log(`  ${unmeasured} entry(s) were SKIPPED as incomplete and keep their previous expectations.`);
    process.exit(3);
  }
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
if (unmeasured) {
  console.log(`${unmeasured} deliverable(s) carry expectations that were never measured.`);
  console.log("Those are not a baseline, and a run that matches them has confirmed nothing.");
  console.log("Re-derive on a machine that has the toolchain they need.");
  process.exit(3);
}
if (failed) {
  console.log(`${failed} deliverable(s) drifted.`);
  console.log("A control that stops firing is as much a regression as one that starts over-firing.");
  console.log("If the change was deliberate, re-derive corpus/manifest.json and say so in the commit.");
  process.exit(1);
}
console.log(`all ${manifest.entries.length} deliverables match.`);
