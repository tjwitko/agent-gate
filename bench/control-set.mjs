// What a run's configuration MEANS, reduced to the things that decide whether two runs are
// comparable: which servers were defined, which were enabled, whether a standing yes was left
// behind, and which PreToolUse hooks were wired.
//
// Deliberately not a textual diff. Claude Code rewrites settings.local.json pretty-printed on any
// interaction, so comparing bytes reports drift on a run whose control set never changed -- and the
// first version of this check did exactly that for slack-opus-1, whose only changes were
// reformatting and an explicit refusal of a server it declined to use. A warning that fires on
// every run is one nobody reads, which is how .gitleaksignore stopped meaning anything.
import { execFileSync } from "child_process";
import { readFileSync } from "fs";

const sortedOr = (a) => [...(a || [])].sort();

export function controlSet(mcp, settings) {
  return {
    defined: sortedOr(Object.keys(mcp?.mcpServers || {})),
    enabled: sortedOr(settings?.enabledMcpjsonServers),
    refused: sortedOr(settings?.disabledMcpjsonServers),
    enableAll: settings?.enableAllProjectMcpServers === true,
    hooks: sortedOr(
      (settings?.hooks?.PreToolUse || []).flatMap((m) => (m.hooks || []).map((h) => h.command))
    ),
  };
}

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

export function readCurrent(dir) {
  const read = (f) => { try { return parse(readFileSync(`${dir}/${f}`, "utf8")); } catch { return null; } };
  return controlSet(read(".mcp.json"), read(".claude/settings.local.json"));
}

export function readAt(dir, sha) {
  const show = (f) => {
    try { return parse(execFileSync("git", ["-C", dir, "show", `${sha}:${f}`], { encoding: "utf8" })); }
    catch { return null; }
  };
  return controlSet(show(".mcp.json"), show(".claude/settings.local.json"));
}

const setDiff = (a, b) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });

/** Differences that change what the run was subject to. Formatting is not one of them. */
export function compare(before, after) {
  const out = [];
  for (const key of ["defined", "enabled", "refused", "hooks"]) {
    const { added, removed } = setDiff(before[key], after[key]);
    // A server the run explicitly refused is a narrowing, not a change in what it was subject to,
    // and it is the outcome the prompt is supposed to produce. Recorded, never flagged.
    if (key === "refused" && removed.length === 0) continue;
    if (added.length) out.push(`${key}: added ${added.join(", ")}`);
    if (removed.length) out.push(`${key}: REMOVED ${removed.join(", ")}`);
  }
  if (before.enableAll !== after.enableAll) {
    out.push(`enableAllProjectMcpServers: ${before.enableAll} -> ${after.enableAll}`);
  }
  return out;
}
