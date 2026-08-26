// The repository boundary: what counts as the model's work, what counts as build output, and
// making sure a repository exists to commit into at all.
//
// Split out of agent-loop.mjs to be testable. Every function here decides something the gate acts
// on, and two of them were changed after real failures without any test to hold the behaviour: a
// run made 26 write_file calls into a plain directory and reported PASSED because no repository
// existed, and another staged 5,040 vendored Terraform files because .external_modules was not
// recognised as build output.

import { existsSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";

// This is not tidiness. `git add -A` with no .gitignore committed an 813MB Terraform provider
// binary in an earlier run, because .terraform/ holds the downloaded providers.
export const ARTIFACT_PATTERNS = [
  ".terraform/",
  // Checkov writes downloaded modules here when run with --download-external-modules, and unlike
  // .terraform it is created by a validator this loop runs itself. One run accumulated 5,040
  // vendored .tf files, staged them all, and could not commit.
  ".external_modules/",
  "*.tfstate",
  "*.tfstate.*",
  "__pycache__/",
  "*.pyc",
  "node_modules/",
  ".venv/",
  "agent-run-report.json",
];

export function ensureGitignore(projectDir) {
  const file = path.join(projectDir, ".gitignore");
  if (existsSync(file)) return; // the project's own choices win
  try {
    writeFileSync(
      file,
      "# Written by the agent loop because none existed. Build output, not work.\n" +
        ARTIFACT_PATTERNS.join("\n") +
        "\n"
    );
  } catch {
    /* advisory scaffolding; never fail a run over it */
  }
}

export function isArtifact(relPath) {
  return (
    relPath === "agent-run-report.json" ||
    relPath.endsWith(".pyc") ||
    /(^|\/)(\.terraform|\.external_modules|__pycache__|node_modules|\.venv)(\/|$)/.test(relPath) ||
    /\.tfstate(\.|$)/.test(relPath)
  );
}


export function ensureRepo(projectDir) {
  const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectDir, encoding: "utf8" });
  if (inRepo.status === 0) return true;
  const init = spawnSync("git", ["init", "-q"], { cwd: projectDir, encoding: "utf8" });
  if (init.status !== 0) {
    console.warn(`[loop] could not initialize a git repository in ${projectDir} — the commit gate will refuse to pass`);
    return false;
  }
  console.log(`[loop] initialized a git repository in ${projectDir} (nothing to commit into otherwise)`);
  return true;
}

