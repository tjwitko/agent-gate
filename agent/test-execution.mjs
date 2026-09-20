// Run the project's test suite and report what happened, instead of reporting that test files exist.
//
// code_quality already reads the tests and says plainly that it did not run them. That honesty was
// correct and it was not enough. A Haiku deliverable shipped a jest config, a test file with
// thirteen cases, and no installed toolchain: `npm test` failed outright with `jest: command not
// found`, and the model's closing report claimed "Comprehensive test coverage". Once the
// dependencies were installed the suite ran 12 tests, and the 3 that failed were exactly the three
// the task names as its judging criteria -- forged signature rejected, repeated delivery not
// overwriting, payload retained as received. Nine passing tests around them read as a working
// suite. Nothing in the pipeline could tell the difference, because nothing ever ran it.
//
// Two deliberate limits on how this executes:
//
//  1. **The runner is invoked directly, never `npm test`.** A package.json `scripts.test` is a
//     model-authored shell string and would run whatever it contains. build_check's precedent is
//     the right one: it calls node --check, py_compile and ruff by name and never runs a script the
//     project defined. Test code is model-authored either way -- that is unavoidable and is the
//     point -- but the command that starts it does not have to be.
//  2. **Dependencies are never installed.** `npm install` on a generated manifest executes
//     arbitrary postinstall hooks, which is a larger step than running the tests themselves. A
//     missing toolchain is reported as what it is: a suite nobody can run, which is a finding
//     against a task that asked for tests someone else can run.
import { existsSync, readFileSync } from "fs";
import path from "path";
import { spawnSync } from "child_process";

import { walk } from "./source-files.mjs";

const TIMEOUT_MS = 120_000;
const TEST_FILE = /(^|\/|\.)(test|tests|spec|__tests__)(\/|\.|_|$)|_test\.(py|go|js|mjs|ts)$/i;

/**
 * Which runner can start this project's tests, as { label, cmd, args, cwd }, or
 * { unavailable } naming what is missing. Never returns a command the project itself authored.
 */
export function detectSuite(projectDir) {
  const files = walk(projectDir);
  const testFiles = files.filter((f) => TEST_FILE.test(f.rel));
  if (testFiles.length === 0) return { unavailable: "no test files were found" };

  const bin = (name) => path.join(projectDir, "node_modules", ".bin", name);
  const pkgPath = path.join(projectDir, "package.json");

  if (existsSync(pkgPath)) {
    let pkg = {};
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      return { unavailable: "package.json could not be parsed, so no runner could be identified" };
    }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const declared = ["jest", "vitest", "mocha", "tap", "ava"].find((r) => deps[r]);

    if (declared) {
      if (!existsSync(bin(declared))) {
        // The project's OWN manifest names this runner. Its absence is not a fact about this
        // machine the way a missing pytest is -- it is the deliverable failing its own declared
        // requirement, and the task asks for tests someone else can run. Marked so the report
        // blocks rather than advises.
        return {
          declaredRunnerMissing: true,
          unavailable:
            `the suite is written for ${declared}, which this project declares in package.json and ` +
            `which is not installed — node_modules/.bin/${declared} does not exist. Nobody can run ` +
            `these tests as delivered, including whoever receives this project. Run \`npm install\` ` +
            `(dependencies are deliberately not installed by this check, because npm install on a ` +
            `generated manifest executes arbitrary postinstall hooks) and make sure the suite passes`,
        };
      }
      return { label: declared, cmd: bin(declared), args: declared === "jest" ? ["--ci"] : [], cwd: projectDir };
    }

    // No declared runner: node's own, which needs nothing installed. Note the narrower pattern --
    // TEST_FILE matches anything under a test/ directory, which is right for "does this project
    // have tests" and wrong for "what should I execute". Handing node --test a helper module like
    // test/fakes.mjs runs it as a test file: harmless when it only exports fakes, and not something
    // to rely on when the helper has side effects.
    const nodeTests = testFiles.filter((f) => /\.(test|spec)\.(m|c)?js$|_test\.(m|c)?js$/.test(f.rel));
    if (nodeTests.length) {
      return {
        label: "node --test",
        cmd: process.execPath,
        args: ["--test", ...nodeTests.map((f) => f.rel)],
        cwd: projectDir,
      };
    }
    return { unavailable: "package.json declares no test runner and no runnable JavaScript tests were found" };
  }

  if (testFiles.some((f) => f.rel.endsWith(".py"))) {
    const probe = spawnSync("python3", ["-m", "pytest", "--version"], { cwd: projectDir, encoding: "utf8" });
    if (probe.status !== 0) return { unavailable: "the tests are Python and pytest is not installed here" };
    return { label: "pytest", cmd: "python3", args: ["-m", "pytest", "-q"], cwd: projectDir };
  }

  if (existsSync(path.join(projectDir, "go.mod"))) {
    return { label: "go test", cmd: "go", args: ["test", "./..."], cwd: projectDir };
  }

  return { unavailable: "no runner could be identified for the test files present" };
}

// Each runner's own summary line. Falling back to the exit code alone would report "the suite
// failed" without saying how much of it did, which is the difference between one broken assertion
// and a suite that never started.
const COUNTERS = [
  // jest: "Tests:  3 failed, 9 passed, 12 total"
  { re: /^\s*Tests:\s+(?:(\d+) failed[,|\s]+)?(?:(\d+) skipped[,|\s]+)?(\d+) passed[,|\s]+(\d+) total/im,
    map: (m) => ({ failed: +(m[1] || 0), passed: +m[3], total: +m[4] }) },
  // vitest: "Tests  2 failed | 10 passed (12)", and with nothing failing "Tests  9 passed (9)".
  // Anchored, and the failed segment is optional. Without both, an all-passing vitest run fell
  // through to the loose counter at the bottom, which matched the "Test Files  1 passed (1)" line
  // above it and reported a nine-test suite as "1 of 1 passed" -- an undercount that still said
  // "passed", which is the kind of wrong answer nobody goes looking for.
  { re: /^\s*Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed\s*\((\d+)\)/im,
    map: (m) => ({ failed: +(m[1] || 0), passed: +m[2], total: +m[3] }) },
  // node --test: "# pass 21" / "# fail 0", or the ℹ-prefixed form
  { re: /[#ℹ]\s*pass\s+(\d+)[\s\S]*?[#ℹ]\s*fail\s+(\d+)/i,
    map: (m) => ({ passed: +m[1], failed: +m[2], total: +m[1] + +m[2] }) },
  // pytest: "3 failed, 9 passed" or "9 passed". Last, and deliberately not allowed to start
  // mid-line: every runner prints some other line containing "N passed", and this pattern will
  // happily read whichever it reaches first.
  { re: /^[^\n]*?(?:(\d+) failed,\s*)?(\d+) passed(?![^\n]*\bfiles?\b)/im,
    map: (m) => ({ failed: +(m[1] || 0), passed: +m[2], total: +(m[1] || 0) + +m[2] }) },
];

// vitest and jest colour their summaries even under CI, and an escape sequence sitting between
// "Tests" and its count defeats anchoring.
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

function parseCounts(rawOutput) {
  const output = rawOutput.replace(ANSI, "");
  for (const c of COUNTERS) {
    const m = c.re.exec(output);
    if (m) return c.map(m);
  }
  return null;
}

// The names matter more than the count. Three failures that are all "could not connect" is an
// environment problem; three failures that name the task's own acceptance criteria is a broken
// deliverable, and only the reader can tell those apart.
function failingNames(output) {
  output = output.replace(ANSI, "");
  const names = new Set();
  for (const re of [
    /^\s*[✕✖x×]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?$/gim, // node --test spec, vitest
    // TAP. `node --test` emits the spec format to a TTY and TAP to a pipe, and this always runs
    // against a pipe -- so which one arrives depends on the Node version, not on anything this code
    // controls. Node 26 emits spec either way; Node 22 emits TAP. Without this line the gate ran on
    // CI and printed "1 of 2 test(s) FAILED" followed by a sentence telling the reader to check the
    // names above, with no names above. Counts survived only because TAP's `# fail` happens to
    // match the count patterns.
    /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/gim,
    /^\s*●\s+(.+)$/gm, // jest
    /^---\s+FAIL:\s+(\S+)/gm, // go
    /^FAILED\s+(\S+)/gm, // pytest
  ]) {
    for (const m of output.matchAll(re)) {
      // TAP names a file-level subtest by its path, which is not a test name. The spec reporter
      // never emits those, so dropping them keeps the two formats reporting the same thing.
      const n = m[1].trim();
      if (!n || /^failing tests|^tests?:/i.test(n)) continue;
      if (/\.(m|c)?[jt]sx?$/.test(n) || /^[./]/.test(n)) continue;
      names.add(n);
    }
  }
  // jest prints each failure twice -- once as `✕ short name` in the run list and again as
  // `● Suite › nested › short name` in the detail. Keeping both padded a three-failure suite out to
  // six lines and made it read as worse than it was. The qualified form is the one to keep: it says
  // which suite the failure came from.
  const all = [...names];
  const deduped = all.filter((n) => !all.some((o) => o !== n && o.endsWith(`\u203a ${n}`)));
  return deduped.slice(0, 12);
}

/** Exposed for tests: each runner's summary is parsed from text, so all five can be checked
 *  without installing five runners. The vitest undercount was invisible in every other way. */
export const parseCountsForTest = parseCounts;

/** Exposed for the same reason parseCounts is: the TAP path only occurs naturally on a Node
 *  version this machine does not run, and it shipped broken because of that. */
export const failingNamesForTest = failingNames;

/** Runs the suite. Returns { ran, unavailable, timedOut, counts, failing, exitCode }. */
export function runTests(projectDir, { timeoutMs = TIMEOUT_MS } = {}) {
  const suite = detectSuite(projectDir);
  if (suite.unavailable) {
    return { ran: false, unavailable: suite.unavailable, declaredRunnerMissing: !!suite.declaredRunnerMissing };
  }

  const r = spawnSync(suite.cmd, suite.args, {
    cwd: suite.cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    // NODE_TEST_CONTEXT is deleted, not merely overridden. When this check itself runs under
    // `node --test`, the child inherits it, switches to the TAP reporter for a parent that is not
    // listening, and its summary comes back in a shape the counters do not read -- so a suite that
    // passed was reported as "the summary could not be parsed". The same would happen to anyone
    // running the validator from inside a test harness, which is exactly where a gate gets used.
    env: (() => {
      const env = { ...process.env, CI: "1", NODE_ENV: process.env.NODE_ENV || "test" };
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_OPTIONS;
      return env;
    })(),
  });

  const output = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (r.error && r.error.code === "ENOENT") {
    return { ran: false, unavailable: `${suite.label} could not be started (${r.error.message})` };
  }
  if (r.signal || (r.error && /timed? ?out/i.test(r.error.message || ""))) {
    return { ran: false, timedOut: true, label: suite.label, unavailable: `${suite.label} did not finish within ${timeoutMs / 1000}s and was killed` };
  }

  return {
    ran: true,
    label: suite.label,
    exitCode: r.status,
    counts: parseCounts(output),
    failing: failingNames(output),
    output: output.slice(-4000),
  };
}

/**
 * Blocking when the suite ran and reported failures — the project's own tests contradicting its own
 * code needs no interpretation. Advisory when it could not run, timed out, or its outcome cannot be
 * read: those are environment facts, and blocking on them would fail work that may be correct.
 */
export function testExecutionReport(projectDir, { wanted = false } = {}) {
  if (!wanted) return { failures: [], advisories: [] };
  return verdictFor(runTests(projectDir));
}

/**
 * The verdict for one completed run. Separated from testExecutionReport so it can be exercised
 * against a synthetic result: the interesting cases here are a suite that exits non-zero without a
 * parseable summary and a runner that never started, and reproducing either through a real
 * project means arranging for a real toolchain to be broken in a specific way.
 */
export function verdictFor(r) {
  if (!r.ran) {
    const line =
      `tests: NOT EXECUTED — ${r.unavailable}. Test files existing is not evidence that they pass, ` +
      `and the task asks for tests someone else can run.`;
    // A runner the project itself declared and did not install is the project's claim failing, so
    // it blocks. Everything else here -- no pytest on this machine, a timeout, no runner
    // identifiable at all -- is a fact about the environment, and blocking on those would fail work
    // that may be correct.
    return r.declaredRunnerMissing ? { failures: [line], advisories: [] } : { failures: [], advisories: [line] };
  }

  const c = r.counts;
  const failedCount = c ? c.failed : null;
  const suiteFailed = failedCount !== null ? failedCount > 0 : r.exitCode !== 0;

  if (!suiteFailed) {
    const detail = c ? `${c.passed} of ${c.total} passed` : `exit 0, though the summary could not be parsed`;
    return { failures: [], advisories: [`tests: ran under ${r.label} — ${detail}.`] };
  }

  const named = r.failing.length ? `\n  ${r.failing.join("\n  ")}` : "";
  const headline = c
    ? `${c.failed} of ${c.total} test(s) FAILED`
    : `the suite exited ${r.exitCode} and its summary could not be parsed`;

  // When the summary parsed, the failing names carry the evidence. When it did not, this finding
  // used to carry NO evidence at all -- it asked the reader to check the names above, and there
  // were no names above, because nothing could be extracted. The output was captured the whole
  // time and discarded here. A suite that exits non-zero without a parseable summary is most often
  // one that never ran: a test binary that would not compile, a missing module, an absent service.
  // Those read identically to a real failure unless the output is shown.
  const evidence =
    !c && r.output
      ? `\n\n  Output (last lines, the summary could not be parsed):\n${r.output
          .trim()
          .split("\n")
          .slice(-25)
          .map((l) => `    ${l}`)
          .join("\n")}`
      : "";

  return {
    failures: [
      `tests: ${headline} under ${r.label}.${named}\n` +
        `These are this project's own tests failing against this project's own code. Check the names ` +
        `above before changing anything: failures that all say the same thing about a connection are ` +
        `an environment this suite needs and does not have, while failures that name the task's ` +
        `acceptance criteria are the deliverable being wrong.${evidence}`,
    ],
    advisories: [],
  };
}
