// Static analysis for injection: request data reaching a shell, a SQL statement or an evaluator.
//
// An outside review found nothing here looked for it, and a probe confirmed it: a Flask service with
// a command injection and a SQL injection was blocked only because a route lacked authentication.
// ruff runs with `--select F` -- undefined names -- and no security rules.
//
// Semgrep, with this project's own rules in agent/sast-rules/, not the registry's: the registry rules
// are under a licence that restricts redistribution, and fetching them at run time would make the gate
// depend on a network it often does not have. The rules are few and specific on purpose:
//
// - ERROR rules are taint rules and BLOCK. They fire only when data from an HTTP request reaches the
//   sink inside one function. Measured before anything was allowed to block: zero hits across 9,940
//   files of real code -- every deliverable and control repository on the development machine, 4,593
//   files of installed Python packages, and 5,066 of installed JavaScript including Express itself.
// - WARNING rules are pattern rules and are ADVISORY: a SQL statement built by formatting, a shell
//   command built from a non-literal. They see the construction without knowing where its input came
//   from, which is also how they catch what the taint rules cannot -- open-source Semgrep's taint
//   analysis stays inside one function, so request data passed to a helper is not followed.
//
// Two ways a project could hide code from the scan, both closed: files are passed to semgrep
// explicitly, from the same walk every other validator uses, because given a directory it obeys the
// project's .semgrepignore and a probe with `src/` in one scanned nothing; and `--disable-nosem`,
// because an inline `# nosemgrep` is a suppression the code's author writes -- the .gitleaksignore
// defect in another form.
import { readdirSync, statSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

import { SKIP_DIRS } from "./skip-dirs.mjs";
import { isDeclaredFixture } from "./fixture-markers.mjs";
import { taskWantsErrorDistinction } from "./code-quality.mjs";

const RULES = fileURLToPath(new URL("./sast-rules/", import.meta.url));
export const SAST_EXT = new Set([".py", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".go"]);
const LANGUAGE = { ".py": "Python", ".go": "Go" };
const MAX_FILE_BYTES = 1024 * 1024;
const CHUNK = 400;
const TIMEOUT_MS = 300_000;

export function sastTargets(projectDir) {
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
      } else if (SAST_EXT.has(path.extname(e.name))) {
        try {
          if (statSync(full).size <= MAX_FILE_BYTES) out.push(full);
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  walk(projectDir);
  return out.sort();
}

function semgrepAvailable() {
  const r = spawnSync("semgrep", ["--version"], { encoding: "utf8", env: semgrepEnv() });
  return r.status === 0 ? r.stdout.trim().split("\n").pop() : null;
}

function semgrepEnv() {
  return { ...process.env, SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0" };
}

function run(files) {
  const r = spawnSync(
    "semgrep",
    ["scan", "--config", RULES, "--json", "--quiet", "--metrics=off", "--disable-version-check",
     "--disable-nosem", "--no-git-ignore", "--timeout", "30", "--max-target-bytes", String(MAX_FILE_BYTES), ...files],
    // SIGKILL, not the default SIGTERM: spawnSync waits for the child to exit after signalling it, and
    // a wedged child that ignores SIGTERM made a timeout bound nothing once already (#5).
    { encoding: "utf8", env: semgrepEnv(), timeout: TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.error || r.signal) {
    return { error: r.error?.code === "ETIMEDOUT" || r.signal ? `semgrep did not finish within ${TIMEOUT_MS / 1000}s` : `semgrep could not be run: ${r.error.message}` };
  }
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    return { error: `semgrep exited ${r.status} without a readable result. ${(r.stderr || "").trim().slice(0, 300)}` };
  }
  // A fatal error (bad rules, a crash) reports results it never produced. Per-file problems are
  // level "warn" and are reported separately below.
  const fatal = (doc.errors || []).filter((e) => e.level === "error");
  if (r.status !== 0 && fatal.length) return { error: `semgrep failed: ${fatal[0].message?.slice(0, 300)}` };
  return { doc };
}

const CATEGORY_ORDER = ["command injection", "SQL injection", "code injection", "error distinction", "error detail"];
const REMEDY = {
  "command injection": "Pass arguments as a list to a call that does not start a shell, and never build a command string from input.",
  "SQL injection": "Use a parameterised query: placeholders in the statement, values passed separately.",
  "code injection": "Parse the input as data — JSON, a number, an allow-list — rather than evaluating it.",
  "error distinction":
    "A malformed request comes back as 5xx instead of 4xx: the caller is told the service is broken when the " +
    "request was, and a webhook sender seeing 5xx retries a request that can never succeed. Add `except " +
    "HTTPException: raise` before the broad handler, and catch only what you can handle.",
};

// Injection blocks whenever it is found. Error distinction blocks only when the task asks for it --
// the same gate the regex this replaced was under (candidate-rules #3) -- and is otherwise an
// advisory. Error detail is always an advisory: exception text in a response is a disclosure, but a
// small one, and not what the task is judged on.
const ADVISORY_WHY = {
  "error distinction": " — the task does not ask for client errors to be kept distinct",
  "error detail": " — a disclosure rather than a defect, but the caller sees internal detail",
  "SQL injection": " — where the value comes from is not known here",
  "command injection": " — where the value comes from is not known here",
};

function blocks(category, taskText) {
  if (category === "error distinction") return taskWantsErrorDistinction(taskText);
  if (category === "error detail") return false;
  return true;
}

export function sastFailures(projectDir, { taskText = "" } = {}) {
  const files = sastTargets(projectDir);
  if (files.length === 0) return { failures: [], advisories: [] };

  const version = semgrepAvailable();
  if (!version) {
    const langs = [...new Set(files.map((f) => LANGUAGE[path.extname(f)] || "JavaScript/TypeScript"))].join(", ");
    return {
      failures: [],
      advisories: [],
      couldNotRun: [
        `semgrep is not installed, so ${files.length} ${langs} file(s) were not checked for injection. ` +
          `Install it — \`brew install semgrep\` or \`pipx install semgrep\` — and re-run.`,
      ],
    };
  }

  const results = [];
  const unparsed = new Set();
  for (let i = 0; i < files.length; i += CHUNK) {
    const r = run(files.slice(i, i + CHUNK));
    if (r.error) return { failures: [], advisories: [], couldNotRun: [`${r.error}; nothing was checked for injection.`] };
    results.push(...(r.doc.results || []));
    for (const e of r.doc.errors || []) if (e.path) unparsed.add(path.relative(projectDir, e.path));
  }

  const at = (x) => `${path.relative(projectDir, x.path)}:${x.start.line}`;
  const blocking = new Map();
  const advisory = new Map();
  // An advisory at a line that already blocks for the same category says nothing the finding does not.
  // Pattern rules (WARNING) see a construction; for injection only the taint rules (ERROR) block.
  const isBlocking = (x) => {
    const category = x.extra?.metadata?.category || "injection";
    if (category === "error distinction" || category === "error detail") return blocks(category, taskText);
    return x.extra?.severity === "ERROR";
  };
  const blocked = new Set(results.filter(isBlocking).map((x) => `${x.extra?.metadata?.category}@${at(x)}`));
  for (const x of results) {
    if (!isBlocking(x) && blocked.has(`${x.extra?.metadata?.category}@${at(x)}`)) continue;
    const category = x.extra?.metadata?.category || "injection";
    const target = isBlocking(x) ? blocking : advisory;
    if (!target.has(category)) target.set(category, { message: x.extra?.message, at: [] });
    target.get(category).at.push(at(x));
  }
  const order = (m) => [...m].sort(([a], [b]) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
  const list = (a) => [...new Set(a)].slice(0, 10).join(", ") + (new Set(a).size > 10 ? `, +${new Set(a).size - 10} more` : "");

  const failures = order(blocking).map(
    ([category, { message, at }]) =>
      `sast: ${category} — ${message}: ${list(at)}. ${REMEDY[category] || ""}`.trimEnd()
  );
  const advisories = order(advisory).map(
    ([category, { message, at }]) =>
      `sast: ${message} (${category}, not blocking${ADVISORY_WHY[category] || ""}): ${list(at)}.`
  );
  if (unparsed.size) {
    advisories.push(
      `sast: ${unparsed.size} file(s) could not be fully parsed, so parts of them were not checked — ${[...unparsed].slice(0, 5).join(", ")}${unparsed.size > 5 ? ", …" : ""}.`
    );
  }
  return { failures, advisories };
}
