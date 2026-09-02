// Robustness, not security. Every other check in this loop is security-shaped, and a three-run
// series showed why that is not enough: the run with by far the best architecture — proper cmd/
// and internal/{handler,repository,service} separation — scored the WORST on the gate, because
// nothing in the gate measures structure, tests or error handling. Gate score and code quality were
// uncorrelated, and there was no mechanism by which they would be.
//
// Both checks below are gated on the task asking for the property, in the same way the immutability
// check is. A project nobody asked to test is not defective for having no tests.

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

import { taskMatcher } from "./task-phrases.mjs";
import { SKIP_DIRS } from "./skip-dirs.mjs";

const MAX_FILE_BYTES = 512 * 1024;
const CODE_EXT = [".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".go", ".rb", ".java"];

// Both gate BLOCKING findings, and taskWantsTests now also gates whether the suite is executed at
// all -- so a miss here silences the newest blocking check entirely. Measured against rephrasings
// before this change: tests 3/8, error distinction 3/7.
//
// The bare `tests?` that used to carry this also fired on "run it in the test environment first",
// inventing a test requirement from an environment name. It keeps its word but not its compounds,
// and that exclusion is a short closed list of nouns rather than an open guess.
const TASK_WANTS_TESTS = taskMatcher({
  any: [
    /\bautomated\s+(?:tests?|checks?|verification)\b/i,
    /\b(?:unit|integration|acceptance|end[-\s]to[-\s]end|e2e|smoke|regression)\s+tests?\b/i,
    /\btest\s+(?:suite|coverage|cases?|harness)\b/i,
    /\b(?:regression|code|test)\s+coverage\b/i,
    /\btests?\b(?!\s+(?:environment|env|data|account|users?|mode|server|instance|fixtures?)\b)/i,
  ],
  // "cover the forged-callback path with specs", "CI must run the suite", "ship it with coverage
  // for the duplicate-delivery case". None of these means a test suite on its own: a spec can be a
  // pod spec, a suite can be a product suite, coverage can be network coverage.
  near: [
    { terms: "specs?|suite|coverage",
      nouns: "covers?|covered|coverage|runs?|written|writes?|passing|assert\\w*|cases?|paths?|CI" },
  ],
});

// `[^.]{0,80}` ran straight through a semicolon: "A bad request is fine; the cluster is not our
// concern" read as a requirement to distinguish errors from faults. Clause-bounded now.
const TASK_WANTS_ERROR_DISTINCTION = taskMatcher({
  any: [
    /\berrors?\s+(?:distinguished|separated|distinct)\s+from\s+faults?\b/i,
    /\bnot\s+(?:be\s+)?(?:reported|treated|returned)\s+as\s+(?:an?\s+)?(?:server\s+error|fault|outage|failure|5\d\d)\b/i,
  ],
  near: [
    { terms: "bad requests?|malformed|invalid\\s+(?:input|payload|body|request)|client (?:errors?|mistakes?)|caller'?s? mistakes?|4xx",
      nouns: "faults?|outages?|server errors?|5xx|5\\d\\d|not|never", window: 50 },
    { terms: "distinguish\\w*|separate[ds]?|differentiate[ds]?",
      nouns: "faults?|server errors?|outages?|failures?", window: 50 },
  ],
});

// A file is a test if it is named like one AND asserts something. Naming alone was not enough: a
// file called test_main.py containing a TODO is not a test, and rewarding it would teach exactly
// the wrong thing.
const TEST_FILENAME = /(^|[\/._-])(tests?|spec)([._-]|$)|_test\.(go|py|rb)$|\.(test|spec)\.(js|mjs|ts|tsx)$/i;
const ASSERTION = /\bassert\w*\s*[(\s]|\bexpect\s*\(|\brequire\.\w+\s*\(|\bt\.(Error|Fatal)f?\s*\(|\bshould\b|\.to(Be|Equal|Throw)\b/;

// A handler that catches broadly and re-raises as a server fault. Observed in four separate
// deliverables: `except Exception` swallows the HTTPException(400) raised a few lines above and
// re-raises it as a 500, so a malformed request from the caller is reported as our own failure —
// and in three of the four, the intended status leaked into the message as "400: Missing event id".
const PY_BROAD_CATCH = /except\s+Exception[^\n]*:\s*\n([\s\S]{0,400}?)(?=\n\S|\n\s*except|\n\s*$)/g;
const RAISES_SERVER_FAULT = /status_code\s*=\s*5\d\d|HTTPException\s*\(\s*5\d\d|abort\s*\(\s*5\d\d/;
const RERAISES_DETAIL = /detail\s*=\s*(?:str\s*\(\s*e\s*\)|f?["'`][^"'`]*\{e\})/;

// A test that patches something the module does not have fails the moment it runs, and looks
// entirely reasonable until then. One deliverable patched `app.main.SECRET_KEY` against a module
// with no such attribute: four of its five tests died with AttributeError, while a check that only
// looked for assertions called the file a test.
//
// This is deliberately narrow — it resolves the dotted path to a file in this project and looks for
// a top-level binding of that name. An unresolvable path is not reported, because the target may
// legitimately live in a dependency.
const PY_PATCH_TARGET = /\bpatch(?:\.object)?\s*\(\s*["']([\w.]+)["']/g;

function resolveModuleFile(files, dotted) {
  const parts = dotted.split(".");
  // Try progressively shorter prefixes: app.main.SECRET_KEY -> app/main.py holding SECRET_KEY.
  for (let take = parts.length - 1; take >= 1; take--) {
    const rel = parts.slice(0, take).join("/") + ".py";
    const f = files.find((x) => x.rel === rel || x.rel.endsWith("/" + rel));
    if (f) return { file: f, attr: parts[take] };
  }
  return null;
}

function walk(dir, exts, acc = [], root = dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, exts, acc, root);
      continue;
    }
    if (!exts.includes(path.extname(e.name))) continue;
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

export function taskWantsTests(taskText = "") {
  return TASK_WANTS_TESTS(taskText);
}
export function taskWantsErrorDistinction(taskText = "") {
  return TASK_WANTS_ERROR_DISTINCTION(taskText);
}

export function checkCodeQuality(projectDir, taskText = "") {
  const files = walk(projectDir, CODE_EXT);
  if (files.length === 0) return { ran: false, unknown: "no source files to read", tests: [], swallowing: [] };

  const tests = files.filter((f) => TEST_FILENAME.test(f.rel) && ASSERTION.test(f.text));
  const namedOnly = files.filter((f) => TEST_FILENAME.test(f.rel) && !ASSERTION.test(f.text));

  const swallowing = [];
  for (const f of files) {
    if (!f.rel.endsWith(".py")) continue;
    PY_BROAD_CATCH.lastIndex = 0;
    let m;
    while ((m = PY_BROAD_CATCH.exec(f.text))) {
      const body = m[1] || "";
      if (RAISES_SERVER_FAULT.test(body)) {
        const line = f.text.slice(0, m.index).split("\n").length;
        swallowing.push({ file: f.rel, line, leaksDetail: RERAISES_DETAIL.test(body) });
      }
    }
  }

  // Patch targets that name an attribute the module does not define.
  const badPatches = [];
  for (const t of tests) {
    if (!t.rel.endsWith(".py")) continue;
    PY_PATCH_TARGET.lastIndex = 0;
    let m;
    while ((m = PY_PATCH_TARGET.exec(t.text))) {
      const resolved = resolveModuleFile(files, m[1]);
      if (!resolved) continue; // target is outside this project; not ours to judge
      const bound = new RegExp(
        `^\\s*(?:${resolved.attr}\\s*[:=]|def\\s+${resolved.attr}\\b|class\\s+${resolved.attr}\\b|async\\s+def\\s+${resolved.attr}\\b)`,
        "m"
      );
      if (!bound.test(resolved.file.text)) {
        badPatches.push({ test: t.rel, target: m[1], module: resolved.file.rel, attr: resolved.attr });
      }
    }
  }

  return { ran: true, unknown: null, tests, namedOnly, swallowing, badPatches };
}

/** Blocking when the task asks for the property; silent otherwise. */
export function codeQualityFailures(projectDir, taskText = "") {
  const r = checkCodeQuality(projectDir, taskText);
  if (!r.ran) return { failures: [], advisories: [`code quality: not checked — ${r.unknown}`] };

  const failures = [];
  const advisories = [];

  if (taskWantsTests(taskText)) {
    if (r.tests.length === 0) {
      const named = (r.namedOnly || []).length;
      failures.push(
        `code quality: the task asks for automated tests and the project contains none.\n` +
          (named
            ? `${named} file(s) are named like tests but contain no assertion, which is not a test — ` +
              `a file that runs code without checking anything passes whatever the code does.\n`
            : "") +
          `Write tests someone else can run: at minimum that a genuine signature is accepted and a ` +
          `forged one rejected, and that a repeated delivery does not overwrite what was already ` +
          `recorded. Those two are the requirements most easily broken by a later change, and the ` +
          `ones no reviewer can confirm by reading.`
      );
    }
  } else if (r.tests.length === 0) {
    advisories.push(`code quality: no tests found. The task did not ask for any, so this is not a failure.`);
  }

  // Never let the presence of tests read as evidence they pass. This check finds files and reads
  // them; it does not run anything. Reporting "3 of 3 runs produced tests" as a result once made a
  // presence measurement sound like a correctness one, and all three test suites turned out to fail
  // when finally executed — one of them could not even compile.
  if (r.tests.length > 0) {
    advisories.push(
      `code quality: ${r.tests.length} test file(s) found and read — ${r.tests.map((t) => t.rel).join(", ")}. ` +
        `This is what is in the files, not what happens when they run; the tests check reports that ` +
        `separately, and its verdict is the one that counts. A test that imports a module before ` +
        `setting the environment that module reads, or patches an attribute it does not have, looks ` +
        `entirely reasonable in the file and fails the moment it runs.`
    );
  }

  if ((r.badPatches || []).length > 0) {
    const list = r.badPatches.map((b) => `${b.test} patches ${b.target}, but ${b.module} defines no ${b.attr}`).join("; ");
    failures.push(
      `code quality: ${r.badPatches.length} test patch target(s) do not exist — ${list}.\n` +
        `unittest.mock.patch raises AttributeError at run time when the attribute is absent, so ` +
        `these tests fail the moment anyone runs them while reading as thorough coverage. Either ` +
        `the name is wrong, or the test was written against an interface the module never had.`
    );
  }

  if (taskWantsErrorDistinction(taskText) && r.swallowing.length > 0) {
    const list = r.swallowing.map((s) => `${s.file}:${s.line}`).join(", ");
    const leaks = r.swallowing.filter((s) => s.leaksDetail).length;
    failures.push(
      `code quality: ${r.swallowing.length} broad exception handler(s) turn a caller's mistake into ` +
        `a server fault — ${list}.\n` +
        `\`except Exception\` catches the HTTPException your own code raised a few lines earlier, so ` +
        `a malformed request comes back as 5xx instead of 4xx. The caller is told the service is ` +
        `broken when the request was; a payment provider seeing 5xx will retry a request that can ` +
        `never succeed.` +
        (leaks
          ? ` ${leaks} of them also pass the original exception into the response body, leaking the ` +
            `intended status and internal detail to the caller.`
          : "") +
        ` Re-raise HTTPException untouched and catch only what you can actually handle.`
    );
  }

  return { failures, advisories };
}
