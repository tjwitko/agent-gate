// Does this project commit a lockfile? It decides whether a dependency finding blocks.
//
// Without a lockfile osv-scanner resolves the transitive graph to minimum-satisfying versions that
// no real install produces, so the findings are real CVEs against versions nobody has. Verified on
// a project pinning fastapi/uvicorn/pydantic exactly, where the scan reported h11 0.9.0 (CVSS 9.1)
// and starlette 0.38.6, neither of which appears in `pip install -r` output. `==` pins are not
// enough: they constrain DIRECT dependencies only.
//
// This lives here rather than being imported from a sibling checkout, and that is the entire point
// of the file. It used to resolve `../../local-copilot-stack/validate/lockfiles.mjs` and return
// FALSE when that path did not exist -- so on every machine except one developer's, every project
// counted as having no lockfile and every high-severity dependency finding was silently downgraded
// to advisory. check_dependencies never blocked anywhere else, and said nothing about it: the
// downgrade was a console.log, absent from the findings, the advisories and the control list alike.
// A security control that switches itself off when a directory is missing is worse than one that
// was never wired up, because the report looks identical either way.
//
// local-copilot-stack keeps its own copy for the git-hook path. The two must agree -- a control
// that answers differently at two enforcement points is a bug at one of them -- and
// lockfiles.test.mjs asserts that whenever both are present.
import { readdirSync } from "fs";
import path from "path";

import { SKIP_DIRS } from "./skip-dirs.mjs";

export const LOCKFILES = [
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "requirements.lock", "poetry.lock", "Pipfile.lock", "pdm.lock", "uv.lock",
  "go.sum", "Cargo.lock", "Gemfile.lock", "composer.lock",
];

/**
 * Recursive: the layout is the project's choice, and a lockfile under app/ is still a lockfile.
 * A root-only check silently downgrades a properly-locked project to advisory, which is the
 * failure direction that teaches people to ignore the result.
 */
export function findsLockfile(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.isDirectory()) {
      if (findsLockfile(path.join(dir, e.name))) return true;
    } else if (LOCKFILES.includes(e.name)) return true;
  }
  return false;
}

export const NOT_AUTHORITATIVE_NOTE =
  "no lockfile, so osv-scanner resolved minimum-satisfying versions and these may not be what " +
  "installs. `==` pins in requirements.txt are not enough — they constrain direct dependencies " +
  "only. Commit a lockfile (for pip: `pip freeze > requirements.lock`) to make this authoritative.";
