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

// --- does a test touch the project at all? --------------------------------
// A deliverable passed both test gates with two files that never reached its code. One computed an
// HMAC twice with the same secret and asserted the results matched -- a property of Node's crypto,
// not of the project. The other copied the source into a string literal and asserted the string
// contained "23505". Both were named like tests, both contained assertions, both passed when run,
// and the commit that added them said so outright: "Add assertions to test files for validator
// detection". Requiring assertions made assertion-shaped files; running them made files that pass.
//
// The property those checks cannot see is whether the tests are about THIS project. Reaching the
// code under test is the one thing a real test must do and a decorative one need not, and unlike an
// assertion count it cannot be satisfied by writing more of the same.
//
// Only languages where an import is the sole route to the code are judged. Go and Java tests live
// in the same package as what they test and reach it with no import at all, so their silence here
// means nothing and they are left alone rather than guessed at.
const IMPORT_JUDGEABLE = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb"]);

function importsProjectCode(file, files, pkgName) {
  const t = file.text;
  if (file.rel.endsWith(".py")) {
    // A dotted import that resolves to a file in this project, or any relative import.
    if (/^\s*from\s+\./m.test(t)) return true;
    for (const m of t.matchAll(/^\s*(?:from|import)\s+([\w.]+)/gm)) {
      if (resolveModuleFile(files, `${m[1]}.x`)) return true;
    }
    return false;
  }
  if (file.rel.endsWith(".rb")) return /\brequire_relative\b|\brequire\s+['"]\.\.?\//.test(t);

  // JavaScript and TypeScript: a relative specifier, a dynamic import of one, a mock of one, or an
  // import of this package by its own name (the "exports" map style).
  if (/(?:^|[^\w])(?:import|export)\s[^;]*?['"]\.\.?\//s.test(t)) return true;
  if (/\brequire\s*\(\s*['"]\.\.?\//.test(t)) return true;
  if (/\bimport\s*\(\s*['"]\.\.?\//.test(t)) return true;
  if (/\b(?:jest|vi)\s*\.\s*mock\s*\(\s*['"]\.\.?\//.test(t)) return true;
  if (pkgName && new RegExp(`['"]${pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/[^'"]*)?['"]`).test(t)) return true;
  return false;
}

/**
 * Which test files reach this project's own code, and which do not.
 * Files in languages where absence of an import proves nothing are not counted either way.
 */
export function testsReachingProject(tests, files, pkgName) {
  const judgeable = tests.filter((t) => IMPORT_JUDGEABLE.has(path.extname(t.rel)));
  const reaching = judgeable.filter((t) => importsProjectCode(t, files, pkgName));
  return { judgeable, reaching, detached: judgeable.filter((t) => !reaching.includes(t)) };
}

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

  // A package that imports itself by name is reaching its own code, so the name is needed to tell
  // that apart from an import of somebody else's library.
  let pkgName = null;
  try {
    pkgName = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8")).name || null;
  } catch {
    /* no package.json, or unreadable: the relative-specifier tests still apply */
  }
  const reach = testsReachingProject(tests, files, pkgName);
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

  return { ran: true, unknown: null, tests, namedOnly, swallowing, badPatches, reach };
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

  // Blocking only when NOTHING in the suite reaches the project: that is a suite which proves
  // nothing whatever, and it passed both existing test gates. A suite where most files reach the
  // code and one does not is a much smaller thing and is reported without blocking -- a decorative
  // test among real ones misleads far less than a decorative suite.
  const reach = r.reach || { judgeable: [], reaching: [], detached: [] };
  if (taskWantsTests(taskText) && reach.judgeable.length > 0 && reach.reaching.length === 0) {
    failures.push(
      `code quality: none of the ${reach.judgeable.length} test file(s) import anything from this ` +
        `project — ${reach.detached.map((t) => t.rel).join(", ")}. A test that never reaches the code ` +
        `under test cannot be evidence about it, however many assertions it contains and whether or ` +
        `not it passes: asserting that two identical HMAC calls agree tests the crypto library, and ` +
        `asserting that a string copied from a source file contains a substring tests the copy. ` +
        `Import the modules being tested and exercise them.`
    );
  } else if (taskWantsTests(taskText) && reach.detached.length > 0) {
    advisories.push(
      `code quality: ${reach.detached.length} of ${reach.judgeable.length} test file(s) import ` +
        `nothing from this project — ${reach.detached.map((t) => t.rel).join(", ")}. Whatever they ` +
        `assert, it is not about this code. Not blocking, because the rest of the suite does reach it.`
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
