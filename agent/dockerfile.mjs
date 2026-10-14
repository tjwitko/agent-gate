// Reading Dockerfiles, not just confirming they exist.
//
// `artifact_presence` confirms a Dockerfile exists when the task names one, and until this file
// nothing read it: `FROM node:14`, four years past its end of life, passed. Two parts, deliberately
// at different strengths:
//
// - BLOCKING: a base image whose release has reached end of life. Deterministic, and about the one
//   thing in a Dockerfile that decides whether the runtime under the code still gets security
//   fixes. Every stage counts: a build stage on an end-of-life Go compiles the toolchain's
//   unpatched standard library into the binary that ships.
// - ADVISORY: checkov's Dockerfile rules -- no USER, no HEALTHCHECK, an unpinned tag and the rest.
//   Most real Dockerfiles miss a HEALTHCHECK, and a blocking check that fires on most projects is a
//   check that gets switched off. Same policy as checkov on Terraform.
//
// checkov has no end-of-life rule, which is why the blocking half is this project's own: checkov
// 3.3.10 over the probe flagged HEALTHCHECK and USER and said nothing about node:14.
//
// The dates are agent/eol-data.mjs, generated from endoflife.date. "Today" is AGENT_GATE_TODAY when
// set, so the frozen corpus judges its fixtures on the date it measured them rather than drifting
// every time a release ages out.
import { readdirSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";

import { SKIP_DIRS } from "./skip-dirs.mjs";
import { isDeclaredFixture } from "./fixture-markers.mjs";
import { EOL, PRODUCTS, EOL_FETCHED } from "./eol-data.mjs";

const isDockerfile = (name) =>
  name === "Dockerfile" || name === "Containerfile" || /^Dockerfile\.[\w.-]+$/.test(name) || /\.[Dd]ockerfile$/.test(name);

export function findDockerfiles(projectDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !isDeclaredFixture(full)) walk(full);
      } else if (isDockerfile(e.name)) {
        out.push(path.relative(projectDir, full));
      }
    }
  };
  walk(projectDir);
  return out.sort();
}

/**
 * Every FROM, with ARG defaults declared before it substituted. A FROM naming an earlier stage, or
 * `scratch`, is not an image. One whose reference still holds an unresolved variable is returned
 * with `unresolved` set, because it cannot be judged.
 */
export function baseImages(text) {
  const args = {};
  const stages = new Set();
  const out = [];
  let fromIndex = -1;
  // Line continuations joined first, keeping the number of the line each instruction starts on.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const start = i + 1;
    let line = lines[i];
    while (/\\\s*$/.test(line) && i + 1 < lines.length) line = line.replace(/\\\s*$/, " ") + lines[++i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const arg = trimmed.match(/^ARG\s+([A-Za-z_]\w*)(?:=(\S*))?/i);
    if (arg) {
      if (arg[2] !== undefined) args[arg[1]] = arg[2].replace(/^["']|["']$/g, "");
      continue;
    }
    const from = trimmed.match(/^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i);
    if (!from) continue;
    const ref = from[1].replace(/\$\{(\w+)(?::-([^}]*))?\}|\$(\w+)/g, (m, a, dflt, b) => {
      const name = a || b;
      return args[name] ?? dflt ?? m;
    });
    fromIndex++;
    // Checked before this FROM's own alias is recorded: `FROM node:20 AS node` names an image.
    const isStage = stages.has(ref.toLowerCase());
    if (from[2]) stages.add(from[2].toLowerCase());
    if (ref.toLowerCase() === "scratch" || isStage) continue;
    out.push({ line: start, ref, stage: from[2] || null, unresolved: /\$/.test(ref), fromIndex });
  }
  // The last FROM is the image that ships; earlier ones are build stages.
  for (const o of out) o.final = o.fromIndex === fromIndex;
  return out;
}

// `docker.io/library/node:14-alpine@sha256:...` -> { repo: "node", tag: "14-alpine" }.
export function parseRef(ref) {
  const noDigest = ref.split("@")[0];
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
  const tag = colon > slash ? noDigest.slice(colon + 1) : null;
  let repo = (colon > slash ? noDigest.slice(0, colon) : noDigest).toLowerCase();
  // Official images only. `bitnami/node` is someone else's image with its own lifecycle.
  repo = repo.replace(/^(?:docker\.io\/|index\.docker\.io\/|registry-1\.docker\.io\/|public\.ecr\.aws\/docker\/|mirror\.gcr\.io\/)?(?:library\/)?/, "");
  return { repo, tag };
}

const today = (env = process.env) => {
  const pinned = env.AGENT_GATE_TODAY;
  if (pinned && /^\d{4}-\d{2}-\d{2}$/.test(pinned)) return pinned;
  return new Date().toISOString().slice(0, 10);
};

const ended = (c, now) => c.eol === true || (typeof c.eol === "string" && c.eol <= now);

// The release cycle a tag names, as the table spells it: `14.21.3-alpine` -> "14" for node,
// `3.9-slim` -> "3.9" for python, `8u392-b08-jre` -> "8" for temurin. Floating tags -- `latest`,
// `lts`, `3` for python -- name no cycle and are not judged here; checkov's pinning rule covers them.
function cycleOf(repo, tag) {
  const parts = PRODUCTS[repo].parts;
  const m = tag.match(/^(\d+)(?:u\d+)?(?:\.(\d+))?/);
  if (!m) return null;
  if (parts === 2 && m[2] === undefined) return null;
  return parts === 1 ? m[1] : `${m[1]}.${m[2]}`;
}

/** End-of-life verdicts for one image reference: the image itself, and an OS named in its tag. */
export function imageEol(ref, now = today()) {
  const { repo, tag } = parseRef(ref);
  const found = [];
  if (!tag) return found;

  if (PRODUCTS[repo]) {
    const cycles = EOL[repo];
    // Debian and Ubuntu tags are as often codenames as numbers.
    const word = tag.split(/[-.]/)[0].toLowerCase();
    const c = cycles.find((x) => x.codename === word) || cycles.find((x) => x.cycle === cycleOf(repo, tag));
    if (c && ended(c, now)) found.push({ label: `${PRODUCTS[repo].label} ${c.cycle}${c.codename ? ` (${c.codename})` : ""}`, eol: c.eol, repo, c });
  }
  // The OS under a language image: `python:3.12-slim-buster`, `node:20-alpine3.16`.
  if (repo !== "debian" && repo !== "ubuntu") {
    for (const word of tag.toLowerCase().split("-")) {
      const deb = EOL.debian.find((x) => x.codename === word) || EOL.ubuntu.find((x) => x.codename === word);
      if (deb && ended(deb, now)) {
        const os = EOL.debian.includes(deb) ? "Debian" : "Ubuntu";
        found.push({ label: `${os} ${deb.cycle} (${deb.codename}), the OS under it`, eol: deb.eol, repo: os.toLowerCase(), c: deb });
      }
    }
  }
  if (repo !== "alpine") {
    const alp = tag.match(/alpine(\d+\.\d+)/);
    const c = alp && EOL.alpine.find((x) => x.cycle === alp[1]);
    if (c && ended(c, now)) found.push({ label: `Alpine Linux ${c.cycle}, the OS under it`, eol: c.eol, repo: "alpine", c });
  }
  return found;
}

// Supported releases to name in the remedy: released, not ended, LTS first where the product has
// the notion, newest first.
function supported(repo, now) {
  const cycles = (EOL[repo] || []).filter((c) => c.released && c.released <= now && !ended(c, now));
  const lts = cycles.filter((c) => c.lts);
  return (lts.length ? lts : cycles).slice(0, 2).map((c) => c.cycle);
}

const CHECKOV_TIMEOUT_MS = 120_000;

function checkovDockerfiles(projectDir, files) {
  const probe = spawnSync("checkov", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    return `dockerfile: checkov is not installed, so ${files.length} Dockerfile(s) were checked for end-of-life base images only — USER, HEALTHCHECK, unpinned tags and the rest of checkov's Dockerfile rules did not run.`;
  }
  const run = spawnSync(
    "checkov",
    ["--framework", "dockerfile", "--compact", "-o", "json", ...files.flatMap((f) => ["-f", path.join(projectDir, f)])],
    { encoding: "utf8", timeout: CHECKOV_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }
  );
  if (run.error || run.signal || !run.stdout) {
    return `dockerfile: checkov did NOT run to completion over the Dockerfiles (${run.signal || run.error?.message || `exit ${run.status}, no output`}). Its rules are unknown here, not clean.`;
  }
  let report;
  try {
    const parsed = JSON.parse(run.stdout);
    report = Array.isArray(parsed) ? parsed.find((r) => r.check_type === "dockerfile") || parsed[0] : parsed;
  } catch {
    return "dockerfile: checkov's output could not be parsed, so its Dockerfile findings are unavailable. Unknown, not clean.";
  }
  const failed = report?.results?.failed_checks || [];
  if (failed.length === 0) return null;
  const byFile = new Map();
  for (const c of failed) {
    const f = path.relative(projectDir, c.file_abs_path || path.join(projectDir, c.file_path || "")) || c.file_path;
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(`${c.check_id} ${c.check_name}`);
  }
  return (
    `dockerfile: checkov reports ${failed.length} finding(s) — not blocking. ` +
    [...byFile].map(([f, list]) => `${f}: ${[...new Set(list)].join("; ")}`).join(" | ")
  );
}

export function dockerfileFailures(projectDir, { env = process.env, checkov = true } = {}) {
  const files = findDockerfiles(projectDir);
  if (files.length === 0) return { failures: [], advisories: [] };
  const now = today(env);
  const failures = [];
  const advisories = [];
  const unresolved = [];

  for (const f of files) {
    let text;
    try {
      text = readFileSync(path.join(projectDir, f), "utf8");
    } catch {
      continue;
    }
    // One finding per Dockerfile, however many FROMs it has: two stages on node:20 are one mistake
    // made twice, and counting them twice inflates the blocking total the way one finding per
    // route would for authentication.
    const hits = [];
    const repos = new Set();
    let buildStage = false;
    for (const img of baseImages(text)) {
      if (img.unresolved) {
        unresolved.push(`${f}:${img.line} ${img.ref}`);
        continue;
      }
      for (const e of imageEol(img.ref, now)) {
        const when = e.eol === true ? "has reached end of life" : `reached end of life on ${e.eol}`;
        hits.push(`line ${img.line} FROM ${img.ref}${img.stage ? ` (stage ${img.stage})` : ""}: ${e.label} ${when}`);
        repos.add(e.repo);
        if (!img.final) buildStage = true;
      }
    }
    if (hits.length) {
      const use = [...repos]
        .map((r) => [r, supported(r, now)])
        .filter(([, s]) => s.length)
        .map(([r, s]) => `${PRODUCTS[r]?.label || r} ${s.join(" or ")}`);
      failures.push(
        `dockerfile: ${f} builds on ${hits.length === 1 ? "a base image" : `${hits.length} base images`} past end of life ` +
          `(endoflife.date, as of ${EOL_FETCHED}) — ${hits.join("; ")}. ` +
          `A release past end of life gets no security fixes, so neither does whatever runs on it.` +
          (use.length ? ` Supported: ${use.join("; ")}.` : "") +
          (buildStage ? " A build stage counts: what it compiles or installs ships in the final image." : "")
      );
    }
  }
  if (unresolved.length) {
    advisories.push(
      `dockerfile: ${unresolved.length} base image(s) named through a variable with no default could not be judged for end of life — ${unresolved.join(", ")}.`
    );
  }
  if (checkov) {
    const ckv = checkovDockerfiles(projectDir, files);
    if (ckv) advisories.push(ckv);
  }
  return { failures, advisories };
}
