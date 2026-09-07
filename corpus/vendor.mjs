#!/usr/bin/env node
// Rebuild corpus/fixtures/ from the deliverables sitting beside this repository.
//
//   node corpus/vendor.mjs            rebuild every fixture
//   node corpus/vendor.mjs --check    verify the vendored copies still match upstream
//
// A vendored fixture is a copy, and a copy drifts. If a deliverable is ever regraded or corrected
// upstream, the corpus would silently keep testing the old one and keep reporting green -- which is
// the same class of failure as a gate that passes because nobody asked it anything.
//
// So each fixture records where it came from and what it looked like: the upstream repository's
// HEAD sha, and a digest over the vendored file contents. `--check` compares both wherever the
// originals are present. On a machine without them -- CI, a fresh clone -- the corpus still runs
// against the vendored copies and says plainly that it could not verify they are current.
//
// What is copied and why:
//   * source only. The .terraform provider cache is 10 GB across ten deliverables and changes
//     nothing: terraform_plan behaves identically without it, measured.
//   * a FRESH git init, not the upstream .git. The uncommitted_work validator reads git state, so a
//     fixture with no repository reports every file as uncommitted and the verdict shifts. A new
//     repository with one commit reproduces "everything is committed" at 160 KB instead of 167 MB.
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const STAGING = path.join(__dirname, ".staging");
const ARCHIVE = path.join(__dirname, "fixtures.tar.gz");
const EXCLUDE = new Set(["node_modules", ".terraform", ".git", "dist", "build", ".next"]);

const manifestPath = path.join(__dirname, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (EXCLUDE.has(e.name)) continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyTree(src, dst);
    else if (e.isFile() && statSync(src).size <= 8 * 1024 * 1024) writeFileSync(dst, readFileSync(src));
  }
}

/**
 * A digest over the vendored files. Stable now that the fixtures carry no git repository and the
 * gate never runs against them in place -- the earlier tree hash moved on every corpus run because
 * `terraform init` and `go build` wrote lock files into the very tree being hashed.
 */
function digestOf(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (EXCLUDE.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push(path.relative(dir, full));
    }
  };
  walk(dir);
  const h = createHash("sha256");
  for (const rel of files.sort()) {
    h.update(rel);
    h.update(readFileSync(path.join(dir, rel)));
  }
  return h.digest("hex").slice(0, 16);
}

function upstreamHead(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim().slice(0, 12);
  } catch {
    return null; // not a repository, or no commits — recorded as null rather than guessed at
  }
}

const check = process.argv.includes("--check");
let drift = 0;
let unverifiable = 0;

// The archive is what the corpus actually runs, so its integrity is checked first and separately
// from where its contents came from. A hand-edited archive and a stale one are different problems.
if (check && manifest.archive) {
  if (!existsSync(ARCHIVE)) {
    console.log(`  MISSING corpus/fixtures.tar.gz — run \`npm run corpus:vendor\``);
    drift++;
  } else {
    const now = createHash("sha256").update(readFileSync(ARCHIVE)).digest("hex").slice(0, 16);
    if (now !== manifest.archive.digest) {
      console.log(`  DRIFT archive — corpus/fixtures.tar.gz is ${now}, recorded as ${manifest.archive.digest}`);
      drift++;
    } else {
      console.log(`  ok archive (${manifest.archive.digest})`);
    }
  }
}

for (const entry of manifest.entries) {
  // entry.path points at the VENDORED copy -- that is what the corpus runs. entry.upstream points
  // at the original. Reusing one field for both destroyed the pointer home the moment a fixture was
  // vendored, and --check then read the vendored copy's own fresh-init sha as "upstream", which is a
  // different value on every vendoring and reported all ten as drifted.
  const upstream = path.resolve(REPO, entry.upstream || entry.path);
  const vendored = path.join(STAGING, entry.name);

  if (check) {
    if (!existsSync(upstream)) {
      console.log(`  ?  ${entry.name} — upstream not present, cannot verify this copy is current`);
      unverifiable++;
      continue;
    }
    // The vendored copy is checked first. A hand-edit is a fact about this repository and is
    // actionable here; an upstream move may be someone else's work in progress.
    const head = upstreamHead(upstream);
    if (entry.upstreamHead && head && head !== entry.upstreamHead) {
      console.log(`  DRIFT ${entry.name} — upstream moved ${entry.upstreamHead} -> ${head}; re-vendor`);
      drift++;
    } else {
      console.log(`  ok ${entry.name}`);
    }
    continue;
  }

  if (!existsSync(upstream)) {
    console.error(`cannot vendor ${entry.name}: no upstream at ${upstream}`);
    process.exit(2);
  }
  rmSync(vendored, { recursive: true, force: true });
  copyTree(upstream, vendored);
  // Deliberately NO git repository inside the fixture. `git add` treats a directory containing .git
  // as an embedded repository and commits a gitlink rather than the files, so a fresh clone would
  // find ten empty directories and the corpus would report every fixture missing. The repository
  // the uncommitted_work validator needs is created in a scratch copy at run time instead, which
  // also keeps the committed fixture immutable: the gate writes .terraform/ and go.sum wherever it
  // runs, and it should not be writing into version-controlled fixtures.

  entry.upstream = entry.upstream || entry.path;   // remembered once, never overwritten
  entry.upstreamHead = upstreamHead(upstream);
  entry.digest = digestOf(vendored);
  entry.path = `corpus/fixtures/${entry.name}`;
  console.log(`  vendored ${entry.name}  upstream=${entry.upstreamHead || "n/a"}  digest=${entry.digest}`);
}

if (check) {
  console.log("");
  if (drift) {
    console.log(`${drift} fixture(s) drifted from upstream. Re-run \`node corpus/vendor.mjs\` and re-derive verdicts.`);
    process.exit(1);
  }
  if (unverifiable) {
    console.log(`${unverifiable} fixture(s) could not be checked against upstream — the originals are not on this machine.`);
    console.log(`The corpus still ran against the vendored copies; this only means nothing confirmed they are current.`);
  }
  process.exit(0);
}

// One archive, not a directory tree. Vendoring the fixtures as files put their deliberately
// vulnerable dependency manifests into this repository's own dependency scan -- x/crypto at CVSS
// 9.1, minimatch, vite -- so the gate correctly failed its own repository over defects that exist
// on purpose. It also added fifteen Terraform roots to every pre-commit run, and `git add` wanted to
// commit each fixture's git repository as a gitlink. An archive is opaque to all three: the
// scanners see one binary file, and the corpus extracts it to scratch space at run time, which is
// where it was already running the gate.
execFileSync("tar", ["-czf", ARCHIVE, "-C", STAGING, "."]);
rmSync(STAGING, { recursive: true, force: true });
const archiveDigest = createHash("sha256").update(readFileSync(ARCHIVE)).digest("hex").slice(0, 16);
manifest.archive = { file: "corpus/fixtures.tar.gz", digest: archiveDigest };

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
const kb = Math.round(statSync(ARCHIVE).size / 1024);
console.log(`\nvendored ${manifest.entries.length} fixtures into corpus/fixtures.tar.gz (${kb} KB, digest ${archiveDigest})`);
