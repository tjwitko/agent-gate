// The scanners and runtimes the gate's checks shell out to, and which version of each is on PATH.
//
// The controls report their own versions, and --version printed only those: the gate and four
// controls. But most of what decides a verdict is not in them. gitleaks reads the secrets,
// osv-scanner the dependencies, semgrep the code; ruff, go and pytest decide whether a suite runs at
// all. A semgrep upgrade moves sast findings with no agent-gate change, and osv-scanner queries a
// live database, so the same tree and the same pins can give different dependency findings on
// different days.
// Two runs are only comparable if this is recorded with them.
//
// Moved here from corpus/run.mjs, where it was written after the corpus froze a non-answer as a
// verdict: the machine that measured three Go fixtures had no Go, so their suites never compiled,
// and nothing recorded that. Now the corpus, --version and the JSON report all use this one probe.
//
// Every tool is probed by name on PATH, as every check and control spawns it.
import { spawn } from "child_process";

// `python3 -m pytest`, not the console script: that is what the tests validator probes, and a
// binary on PATH is a different fact from the module being importable by this interpreter.
const PROBES = [
  ["go", "go", ["version"], /go(\d+\.\d+(?:\.\d+)?)/],
  ["terraform", "terraform", ["version"], /Terraform v(\d+\.\d+\.\d+)/],
  ["gitleaks", "gitleaks", ["version"], /(\d+\.\d+\.\d+)/],
  ["osv-scanner", "osv-scanner", ["--version"], /(\d+\.\d+\.\d+)/],
  ["checkov", "checkov", ["--version"], /(\d+\.\d+\.\d+)/],
  ["python3", "python3", ["--version"], /(\d+\.\d+\.\d+)/],
  ["ruff", "ruff", ["--version"], /(\d+\.\d+\.\d+)/],
  ["semgrep", "semgrep", ["--version"], /(\d+\.\d+\.\d+)/],
  ["pytest", "python3", ["-m", "pytest", "--version"], /(\d+\.\d+\.\d+)/],
  ["docker", "docker", ["--version"], /(\d+\.\d+\.\d+)/],
];

const TIMEOUT_MS = 30_000;

/**
 * Run one probe. A version string; null when the tool is not there (it could not be started, or it
 * exited non-zero -- `python3 -m pytest` without the module); "unknown" when it ran and answered
 * with nothing that reads as a version, or did not answer in time. Present-but-unreadable and
 * absent are different facts, and the second is the one that switches checks off.
 */
function probe(cmd, args, re, env) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("unknown"); }, TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const m = re.exec(out);
      resolve(m ? m[1] : "unknown");
    });
  });
}

/** Every tool, always: a missing one is null, never left out. Probed in parallel. */
export async function toolchain({ env = process.env } = {}) {
  const found = await Promise.all(PROBES.map(([, cmd, args, re]) => probe(cmd, args, re, env)));
  const out = { node: process.version.replace(/^v/, "") };
  PROBES.forEach(([name], i) => { out[name] = found[i]; });
  return out;
}

/** Differences between the toolchain that measured something and the one running now. */
export function toolchainDrift(recorded, current) {
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
