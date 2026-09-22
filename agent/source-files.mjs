// Reading a project's source, shared by the checks that scan it.
//
// Extracted rather than copied. This file's neighbours have twice paid for a duplicated definition:
// two credential word lists in authentication.mjs drifted until one learned `authorization` and the
// other did not, and immutability.mjs briefly carried two answers to "what is a comment". A check
// that reads a different set of files, or strips a different set of lines, from the check beside it
// gives two verdicts about one project and no way to tell which is right.
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

import { SKIP_DIRS } from "./skip-dirs.mjs";
import { isDeclaredFixture } from "./fixture-markers.mjs";

// .go, .rb and .java were absent once, so a check could not read a Go deliverable's source at all —
// it reported a project that HAD its control as having none, and no amount of fixing the pattern
// would have helped because the file was never opened. The language list must track the languages
// the loop can actually build.
export const READ_EXT = new Set([
  ".py", ".sql", ".tf", ".tfvars", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".go", ".rb", ".java",
  ".yaml", ".yml",
]);

const MAX_FILE_BYTES = 512 * 1024;

/** Every readable source file under `dir`, as [{ rel, text }]. */
export function walk(dir, acc = [], root = dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // A declared fixture is deliberately unrepresentative; see fixture-markers.mjs.
      if (!SKIP_DIRS.has(e.name) && !isDeclaredFixture(full)) walk(full, acc, root);
    } else if (READ_EXT.has(path.extname(e.name))) {
      try {
        if (statSync(full).size <= MAX_FILE_BYTES) {
          acc.push({ rel: path.relative(root, full), text: readFileSync(full, "utf8") });
        }
      } catch {
        /* unreadable is not a check's problem to report */
      }
    }
  }
  return acc;
}

// Drops whole-line comments only. A line-anywhere stripper would cut at the `//` inside a URL and
// could remove real code sitting after it; the case this exists for -- a commented-out terraform
// setting read as a live one -- is always a leading marker.
export function uncommented(text) {
  return text
    .split("\n")
    .filter((l) => !/^\s*(?:#|\/\/|\*|--)/.test(l))
    .join("\n");
}

export function firstMatch(re, text) {
  const m = re.exec(text);
  return m ? m[0] : null;
}
