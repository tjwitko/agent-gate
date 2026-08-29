// A secret read once and cached forever, in a system whose task says the secret rotates.
//
// webhook-5 fetched its signing secret from Secrets Manager, memoised it in a module-level dict,
// and never invalidated it. Measured consequence, in the worse of the two possible directions:
//
//   after rotation, callbacks signed with the NEW key -> 401   (the provider's real traffic dropped)
//   after rotation, callbacks signed with the OLD key -> 200   (a retired secret honoured forever)
//
// Both halves matter. The first is an outage; the second means revoking a compromised secret does
// nothing until every pod restarts. No gate saw it: the code fetches from a real secret store with
// correct IAM, and reads as careful.
//
// Gated on the task actually stating that the secret rotates, in the same way the immutability
// check is gated on the task stating immutability. Caching a secret is ordinary and correct when
// nothing rotates it; it is a defect only against a stated rotation requirement. A check that
// flagged every memoised secret would be noise on most projects.

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { SKIP_DIRS } from "./skip-dirs.mjs";

const MAX_FILE_BYTES = 512 * 1024;
const CODE_EXT = [".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".go", ".rb", ".java"];

const ROTATION_PHRASES = [
  /\brotat(?:e|es|ed|ing|ion)\b/i,
  /\bevery\s+(?:quarter|month|week|90\s*days)\b/i,
  /\bre-?issues?\b/i,
];
const SECRET_WORD = /\b(secret|signing\s+key|api\s+key|credential|token|password)\b/i;

/** Does the task state that a secret changes over time? */
export function taskRequiresRotation(taskText = "") {
  return ROTATION_PHRASES.some((re) => re.test(taskText)) && SECRET_WORD.test(taskText);
}

// Reading a secret from a managed store. Deliberately not "reads an env var": a secret delivered
// by env cannot rotate without a restart anyway, so caching it changes nothing.
// Only real managed-store APIs. An earlier version also matched a bare `get_secret(`, which is an
// ordinary user-defined helper name -- it fired on a project whose helper fetches fresh on every
// request, i.e. the one shape that rotates correctly.
const SECRET_FETCH =
  /\bget_secret_value\s*\(|\bGetSecretValue\b|\bgetSecretValue\s*\(|\bGetSecretValueCommand\b|\bget_parameter\s*\(|\bGetParameterCommand\b|\baccessSecretVersion\s*\(/;

// A read-through memo: the value is fetched only when absent, so it is fetched exactly once. The
// guard alone is far too weak to act on -- `if not x_provider_signature:` is an ordinary argument
// check and matched one of these patterns 12 lines above an unrelated fetch. So the guard's
// identifier must ALSO be the thing assigned near the fetch; a conditional that guards something
// other than the cache is not evidence of a cache.
const MEMO_GUARDS = [
  /\bif\s+["'`]?[\w."'`]+["'`]?\s+not\s+in\s+(\w+)/,
  /\bif\s+not\s+(\w+)[\s:.[]/,
  /\bif\s+(\w+)\s+is\s+None\b/,
  /\bif\s*\(\s*!\s*(\w+)/,
  /\bif\s*\(\s*(\w+)(?:\.\w+)*\s*===?\s*(?:null|undefined)\s*\)/,
];
// Memo decorators cache by construction and name no container of their own.
const MEMO_DECORATOR = /@lru_cache|@cache\b|@cached/;

function guardedNames(window) {
  const names = new Set();
  for (const re of MEMO_GUARDS) {
    const g = new RegExp(re.source, "g");
    let m;
    while ((m = g.exec(window))) names.add(m[1]);
  }
  return names;
}

function assignedNames(window) {
  const names = new Set();
  const g = /(?:^|\n)\s*(?:const|let|var|self\.)?\s*(\w+)\s*(?:\[[^\]]*\])?\s*=(?!=)/g;
  let m;
  while ((m = g.exec(window))) names.add(m[1]);
  return names;
}

// Anything that lets a cached value be re-read later. Checked across the whole file rather than
// near the fetch: if a project implements expiry anywhere for this secret, this check stands down
// rather than argue about whether the implementation is good enough. Errs toward silence, because
// this one blocks.
const INVALIDATION_EVIDENCE =
  /\bttl\b|\btime_?to_?live\b|\bexpir\w*|\bmax_?age\b|\brefresh\w*|\binvalidat\w*|\breload\w*|\.clear\s*\(\)|\.pop\s*\(|\bdel\s+\w+\[|TTLCache|cache_clear|\bcachetools\b|\bstale\b|\brotat\w*/i;

function walkCode(dir, acc = [], root = dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkCode(full, acc, root);
      continue;
    }
    if (!CODE_EXT.includes(path.extname(e.name))) continue;
    try {
      if (statSync(full).size <= MAX_FILE_BYTES) {
        acc.push({ rel: path.relative(root, full), text: readFileSync(full, "utf8") });
      }
    } catch {
      /* unreadable is not this check's problem to report */
    }
  }
  return acc;
}

export function checkSecretRotation(projectDir, taskText = "") {
  const required = taskRequiresRotation(taskText);
  const files = walkCode(projectDir);
  if (files.length === 0) return { ran: false, required, unknown: "no source files to read", findings: [] };

  const fetchers = [];
  const findings = [];

  for (const f of files) {
    const lines = f.text.split("\n");
    if (!SECRET_FETCH.test(f.text)) continue;
    fetchers.push(f.rel);

    // If the file shows any way for the value to be re-read, stand down for this file.
    if (INVALIDATION_EVIDENCE.test(f.text)) continue;

    lines.forEach((line, i) => {
      if (!SECRET_FETCH.test(line)) return;
      // The memo guard sits just above the fetch in a read-through cache. Bounded so an unrelated
      // conditional elsewhere in the file cannot supply the evidence.
      const window = lines.slice(Math.max(0, i - 12), i + 4).join("\n");
      const guarded = guardedNames(window);
      const assigned = assignedNames(window);
      const cached = [...guarded].some((n) => assigned.has(n));
      if (cached || MEMO_DECORATOR.test(window)) {
        findings.push({ file: f.rel, line: i + 1, code: line.trim().slice(0, 120) });
      }
    });
  }

  if (fetchers.length === 0) {
    return {
      ran: true,
      required,
      unknown: required
        ? "the task says a secret rotates, but nothing here reads a secret from a managed store — " +
          "a secret delivered another way cannot pick up a rotation without a restart"
        : null,
      findings: [],
    };
  }
  return { ran: true, required, unknown: null, findings };
}

/** Blocking when the task states rotation; advisory otherwise. */
export function secretRotationFailures(projectDir, taskText = "") {
  const r = checkSecretRotation(projectDir, taskText);
  if (!r.ran) return { failures: [], advisories: [`secret rotation: not checked — ${r.unknown}`] };
  if (r.unknown) return { failures: [], advisories: [`secret rotation: ${r.unknown}`] };
  if (r.findings.length === 0) return { failures: [], advisories: [] };

  const list = r.findings.map((x) => `${x.file}:${x.line}`).join(", ");
  const message =
    `secret rotation: a secret is fetched once and cached with nothing that can ever re-read it — ` +
    `${list}.\n` +
    `The task states that this secret rotates. A read-through cache with no expiry means the ` +
    `process keeps using whatever it read first, which fails in both directions at once: after a ` +
    `rotation the real sender's requests are rejected, and the retired secret keeps being accepted ` +
    `until every replica restarts — so revoking a compromised secret does nothing. Give the cached ` +
    `value a TTL shorter than the rotation period, or re-fetch on a verification failure before ` +
    `rejecting.`;

  return r.required ? { failures: [message], advisories: [] } : { failures: [], advisories: [message] };
}
