// Manifests whose dependencies nothing scanned.
//
// osv-scanner reads lockfiles. Of manifests it reads only requirements*.txt, go.mod and pom.xml;
// every other manifest is read through its lockfile or not at all. So a package.json with
// dependencies and no lockfile is not scanned less accurately, it is not scanned -- and it was
// reported as a dependency check that ran and found nothing. A probe depending on lodash 4.17.4 with
// no lockfile exited 0, with no advisory; the same project with a lockfile blocked on four high
// findings. Deleting the lockfile before committing removed a critical finding rather than
// downgrading it.
//
// Both tables are measured against osv-scanner 2.4.0 -- the version control-tooling pins -- by
// running it over a manifest or lockfile pinning a known-vulnerable package, not taken from its
// documentation. Two results that documentation would not have predicted: bun.lockb, being binary,
// is not read (bun.lock is), and requirements.lock is not read (requirements-lock.txt is, because
// the match is requirements*.txt).
//
// A manifest that declares no dependencies needs no lockfile: there is nothing to scan, and blocking
// a package.json that only holds scripts would teach people to ignore this check.
import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";

import { SKIP_DIRS } from "./skip-dirs.mjs";

const PY_LOCKS = ["poetry.lock", "pdm.lock", "uv.lock", "Pipfile.lock", "pylock.toml"];
const isRequirementsTxt = (name) => /^requirements.*\.txt$/.test(name);

// For each manifest osv-scanner cannot read: the lockfiles it CAN read that cover it, a test for
// whether the manifest declares anything, and the command that writes a lockfile.
export const NEEDS_LOCKFILE = {
  "package.json": {
    ecosystem: "npm",
    locks: ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock"],
    declares: (text) => {
      let pkg;
      try {
        pkg = JSON.parse(text);
      } catch {
        // Unreadable is not "declares nothing". It is the one case where saying nothing is a pass.
        return true;
      }
      return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some(
        (k) => pkg[k] && typeof pkg[k] === "object" && Object.keys(pkg[k]).length > 0
      );
    },
    fix: "`npm install` writes package-lock.json (yarn, pnpm and `bun install --save-text-lockfile` also work; bun.lockb does not — it is binary and osv-scanner cannot read it)",
  },
  "Cargo.toml": {
    ecosystem: "crates.io",
    locks: ["Cargo.lock"],
    declares: (text) =>
      tomlDeclares(text, (h) => /^(?:workspace\.|target\..+\.)?(?:dev-|build-)?dependencies(?:\..+)?$/.test(h), {
        headerAlone: (h) => /dependencies\..+$/.test(h),
      }),
    fix: "`cargo generate-lockfile` writes Cargo.lock",
  },
  Pipfile: {
    ecosystem: "PyPI",
    locks: ["Pipfile.lock"],
    declares: (text) => tomlDeclares(text, (h) => h === "packages" || h === "dev-packages"),
    fix: "`pipenv lock` writes Pipfile.lock",
  },
  "pyproject.toml": {
    ecosystem: "PyPI",
    locks: PY_LOCKS,
    coveredBy: isRequirementsTxt,
    declares: pyprojectDeclares,
    fix: "`uv lock`, `poetry lock` or `pdm lock` writes a lockfile; or `pip freeze > requirements-lock.txt` (not requirements.lock, which osv-scanner does not read)",
  },
  "build.gradle": { ecosystem: "Maven", locks: ["gradle.lockfile"], declares: gradleDeclares, fix: "`./gradlew dependencies --write-locks` writes gradle.lockfile" },
  "build.gradle.kts": { ecosystem: "Maven", locks: ["gradle.lockfile"], declares: gradleDeclares, fix: "`./gradlew dependencies --write-locks` writes gradle.lockfile" },
  Gemfile: {
    ecosystem: "RubyGems",
    locks: ["Gemfile.lock"],
    declares: (text) => /^\s*gem\s+['"]/m.test(text),
    fix: "`bundle lock` writes Gemfile.lock",
  },
  "composer.json": {
    ecosystem: "Packagist",
    locks: ["composer.lock"],
    declares: (text) => {
      let c;
      try {
        c = JSON.parse(text);
      } catch {
        return true;
      }
      // `php` and `ext-*` are platform requirements, not packages anything installs or scans.
      const real = (o) => Object.keys(o || {}).filter((k) => k !== "php" && !k.startsWith("ext-"));
      return real(c.require).length + real(c["require-dev"]).length > 0;
    },
    fix: "`composer update --lock` writes composer.lock",
  },
};

// Whether any section accepted by `wanted` holds at least one key. Line-based rather than a TOML
// parser: this needs "is the section empty", and a dependency on a parser for that is a dependency
// that can be missing.
function tomlDeclares(text, wanted, { headerAlone = () => false } = {}) {
  let inWanted = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const header = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (header) {
      const h = header[1].replace(/["']/g, "");
      inWanted = wanted(h);
      // `[dependencies.serde]` is a dependency even when every key under it is optional.
      if (inWanted && headerAlone(h)) return true;
      continue;
    }
    if (inWanted && /^[\w.\-"']+\s*=/.test(line)) return true;
  }
  return false;
}

function pyprojectDeclares(text) {
  // Poetry and PEP 735 groups: any key except the interpreter constraint.
  const poetry = (h) =>
    h === "tool.poetry.dependencies" || h === "tool.poetry.dev-dependencies" ||
    /^tool\.poetry\.group\..+\.dependencies$/.test(h);
  let section = "";
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, "").trim();
    if (!line) continue;
    const header = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (header) {
      section = header[1].replace(/["']/g, "");
      continue;
    }
    if (poetry(section) && /^[\w.\-"']+\s*=/.test(line) && !/^["']?python["']?\s*=/.test(line)) return true;
    if (section === "project.optional-dependencies" || section === "dependency-groups") {
      if (/=\s*\[\s*["']/.test(line)) return true;
      if (/=\s*\[\s*$/.test(line) && arrayHasString(lines, i)) return true;
    }
    if (section === "project" && /^dependencies\s*=/.test(line)) {
      if (/\[\s*["']/.test(line)) return true;
      if (/\[\s*$/.test(line) && arrayHasString(lines, i)) return true;
    }
  }
  return false;
}

// A multi-line array opened on line i: does it hold a string before it closes?
function arrayHasString(lines, i) {
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j].replace(/#.*$/, "").trim();
    if (/^["']/.test(l)) return true;
    if (l.startsWith("]")) return false;
  }
  return false;
}

function gradleDeclares(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const re = /\bdependencies\s*\{/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 1;
    let j = m.index + m[0].length;
    const start = j;
    while (j < code.length && depth > 0) {
      if (code[j] === "{") depth++;
      else if (code[j] === "}") depth--;
      j++;
    }
    if (code.slice(start, j - 1).trim()) return true;
  }
  return false;
}

// A lockfile in the manifest's directory or any directory above it, up to the project root:
// workspaces (npm, Cargo) keep one lockfile at the root for every member.
function covered(projectDir, dir, rule) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (rule.locks.some((l) => existsSync(path.join(d, l)))) return true;
    if (rule.coveredBy) {
      try {
        if (readdirSync(d).some(rule.coveredBy)) return true;
      } catch {
        /* unreadable directory; keep climbing */
      }
    }
    if (path.relative(projectDir, d) === "" || d === path.dirname(d)) return false;
  }
}

/**
 * Every manifest under projectDir that declares dependencies osv-scanner cannot read, with no
 * lockfile that it can. Each is a dependency set no scanner looked at.
 */
export function unscannedManifests(projectDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
        continue;
      }
      const rule = NEEDS_LOCKFILE[e.name];
      if (!rule) continue;
      let text;
      try {
        text = readFileSync(path.join(dir, e.name), "utf8");
      } catch {
        text = null;
      }
      if (text !== null && !rule.declares(text)) continue;
      if (covered(projectDir, dir, rule)) continue;
      out.push({
        manifest: path.relative(projectDir, path.join(dir, e.name)),
        ecosystem: rule.ecosystem,
        fix: rule.fix,
      });
    }
  };
  walk(projectDir);
  return out;
}
