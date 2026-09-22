// Directories a project has declared deliberately unrepresentative.
//
// A security tool's own fixtures are broken on purpose: that is what proves its rules fire.
// terraform-guard ships `fixtures/aws-insecure`, identity-guard ships `fixtures/violating`, and
// scanning either of them produces findings that are the point rather than a defect. Both projects
// already mark those directories, and the pre-commit hook already honours the markers -- it records
// a SKIP with the stated reason and calls the overall result partial. This gate did not, so the two
// repositories that most obviously should pass it could not.
//
// The same reasoning as `.gitleaksignore` and `.identity-exception` applies to the escape hatch
// itself: a control with no legitimate way to say "this one, for this reason" gets bypassed
// wholesale. So a marker must carry a reason, and every exemption is reported on every run. An
// exemption nobody can see is indistinguishable from a check that did not run.
import { existsSync, readFileSync, readdirSync } from "fs";
import path from "path";

import { SKIP_DIRS } from "./skip-dirs.mjs";

/**
 * The marker filenames. These are the same two `GUARD_CONFIG_FILES` names the commit gate refuses
 * to let a model add on its own, which is the other half of the bargain: the escape hatch is
 * legitimate, and writing yourself one mid-run is not.
 */
export const FIXTURE_MARKERS = [".tfguard-fixture", ".identity-exception"];

/**
 * Why this directory is declared a fixture, or null if it is not one.
 *
 * The reason is the first non-empty, non-comment line. A blank or comment-only marker exempts
 * NOTHING -- identity-guard learned that when a model, told to remove an exemption, emptied the
 * file instead and the empty file went on exempting the directory.
 */
export function fixtureReason(dir) {
  for (const marker of FIXTURE_MARKERS) {
    const file = path.join(dir, marker);
    if (!existsSync(file)) continue;
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // unreadable is not a declaration
    }
    const line = text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (line) return { marker, reason: line };
  }
  return null;
}

/** True when `dir` itself is declared a fixture. Callers use it to stop descending. */
export function isDeclaredFixture(dir) {
  return fixtureReason(dir) !== null;
}

/**
 * Every declared fixture directory under `root`, for reporting. Does not descend into one: the
 * whole directory is out of scope, and listing its subdirectories separately would say the same
 * thing several times.
 *
 * A marker at the scan root is ignored, for the reason identity-guard refuses one there: at the
 * root, the scope of "this one directory, for this reason" is the entire project.
 */
export function declaredFixtures(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const declared = fixtureReason(full);
      if (declared) {
        out.push({ path: path.relative(root, full) || ".", ...declared });
        continue; // out of scope entirely; nothing below it is reported separately
      }
      walk(full);
    }
  };
  walk(root);
  return out;
}
