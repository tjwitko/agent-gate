// Where the four guard servers live, for a machine that is not this one.
//
// The validator has only ever run from inside this repository, with four sibling repositories
// checked out beside it. That is fine here and impossible for anyone else, so resolution is now
// ordered from most explicit to most local:
//
//   1. an environment variable        — TFGUARD_SERVER and friends, for CI and one-off overrides
//   2. .agent-gate.json in the project under test — the project says what it is gated by
//   3. node_modules                   — controls installed as ordinary npm dependencies
//   4. the sibling path               — how this repo has always worked, kept for development
//
// A control that resolves from nowhere is an exit-3 condition, never a silent skip. That rule is
// the whole reason this file reports HOW each control resolved rather than only THAT it did: a
// gate that quietly ran three checks instead of four is the failure this project exists to remove,
// and it has happened here twice -- once when the runner passed an empty tool registry and printed
// "BLOCKING: none", once when identity-guard sat unspawned through ten graded runs.
import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The four controls, in the order the report should list them. `env` is keyed by the variable each
 * server actually reads -- terraform-guard takes TF_WORKING_ROOT, the other three take SCAN_ROOT.
 * Inventing a name for one of these is not an error at runtime: an unrecognised variable is simply
 * ignored, the server falls back to its own cwd, and it scans whatever happens to be there. That
 * cost a run, and it is why these are written out rather than derived.
 */
export const CONTROL_SPECS = [
  { name: "terraform-guard", pkg: "terraform-guard-mcp", envVar: "TFGUARD_SERVER", provides: ["terraform_plan"], rootVar: "TF_WORKING_ROOT" },
  { name: "dep-audit", pkg: "dep-audit-mcp", envVar: "DEPAUDIT_SERVER", provides: ["check_dependencies"], rootVar: "SCAN_ROOT" },
  { name: "secret-guard", pkg: "secret-guard-mcp", envVar: "SECRETGUARD_SERVER", provides: ["scan_path"], rootVar: "SCAN_ROOT" },
  { name: "identity-guard", pkg: "identity-guard-mcp", envVar: "IDENTITYGUARD_SERVER", provides: ["check_auth_posture"], rootVar: "SCAN_ROOT" },
];

export const CONFIG_FILE = ".agent-gate.json";

/** The project's own declaration of what gates it, if it has one. */
export function readConfig(projectDir) {
  const file = path.join(projectDir, CONFIG_FILE);
  if (!existsSync(file)) return { config: null, error: null };
  try {
    return { config: JSON.parse(readFileSync(file, "utf8")), error: null };
  } catch (err) {
    // Reported, never ignored. A malformed config that reads as "no config" would silently drop
    // the project back to sibling paths that do not exist on the reader's machine.
    return { config: null, error: `${CONFIG_FILE} could not be parsed: ${err.message}` };
  }
}

function fromNodeModules(pkg) {
  // Resolved from this file's location, so the controls travel as dependencies of the gate rather
  // than of whatever project is being scanned.
  const require = createRequire(import.meta.url);
  for (const specifier of [`${pkg}/index.mjs`, pkg]) {
    try {
      return require.resolve(specifier);
    } catch {
      /* not installed under that specifier */
    }
  }
  return null;
}

/**
 * Resolves every control against one project.
 * Returns [{ name, provides, entry, source, rootVar, error }] where `source` names the rule that
 * won and `entry` is null when nothing resolved.
 */
export function resolveControls(projectDir, { config = null, env = process.env } = {}) {
  const siblings = path.resolve(__dirname, "..", "..");
  const configured = (config && config.controls) || {};

  return CONTROL_SPECS.map((spec) => {
    const candidates = [
      { source: `env ${spec.envVar}`, entry: env[spec.envVar] || null },
      {
        source: `${CONFIG_FILE} controls.${spec.name}`,
        entry: configured[spec.name] ? path.resolve(projectDir, configured[spec.name]) : null,
      },
      { source: `node_modules ${spec.pkg}`, entry: fromNodeModules(spec.pkg) },
      { source: `sibling ../${spec.pkg}`, entry: path.join(siblings, spec.pkg, "index.mjs") },
    ];

    for (const c of candidates) {
      if (!c.entry) continue;
      // An env var or a config entry pointing at a file that does not exist is an error, not a
      // reason to fall through: someone said where the control is and was wrong, and quietly using
      // a different one would hide that.
      const explicit = c.source.startsWith("env ") || c.source.startsWith(CONFIG_FILE);
      if (existsSync(c.entry)) return { ...spec, entry: c.entry, source: c.source, error: null };
      if (explicit) {
        return { ...spec, entry: null, source: c.source, error: `${c.source} points at ${c.entry}, which does not exist` };
      }
    }
    return {
      ...spec,
      entry: null,
      source: null,
      error: `not found — set ${spec.envVar}, add controls.${spec.name} to ${CONFIG_FILE}, or install ${spec.pkg}`,
    };
  });
}
