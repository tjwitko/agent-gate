// What the project is being held to: the task file, plus a baseline from outside the project.
//
// Six checks are gated on the task's text, and the task file usually lives in the repository it
// describes -- so whoever writes the code can edit the requirement the code is checked against. An
// agent blocked by "the API key must be rotated every 90 days" can delete that sentence and commit.
// It is the .identity-exception defect again, with the task file in the role of the suppression
// file: the guard the model can edit is not a guard.
//
// Two answers, for the two places the gate runs:
//
// - At commit time (--pre-commit), a commit that changes a tracked task file is blocked, and the
//   code is checked against the requirements as they were. The task is read from the version being
//   committed, not the working tree, so an unstaged edit cannot loosen it either. Adding a task file
//   is not a change to an existing requirement, so a project's first commit is unaffected.
// - In CI, a baseline: requirement sentences from outside the project -- a file, or the Action's
//   `baseline` input -- appended to the task. A workflow the code's author cannot edit can then
//   require tests, rotation or anything else the gated checks read, whatever the task says.
//
// Neither stops someone with a shell who means to get past: `git commit --no-verify` exists, and a
// workflow file is in the repository too. The point is that weakening a requirement becomes a
// deliberate, visible act rather than an edit indistinguishable from the work.
import { readFileSync, realpathSync, existsSync, statSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout || "" };
}

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

const inside = (dir, p) => {
  const rel = path.relative(dir, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * The task text to check against at commit time, and whether this commit changes it.
 * Returns null when the task file is not tracked in a repository, in which case the working tree is
 * all there is.
 */
export function taskAtCommit(taskFile) {
  const abs = real(taskFile);
  const top = git(path.dirname(abs), ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  const root = real(top.out.trim());
  if (!inside(root, abs)) return null;
  const rel = path.relative(root, abs).split(path.sep).join("/");

  const status = git(root, ["diff", "--cached", "--name-status", "--no-renames", "--", rel]).out.trim().split("\t")[0];
  const staged = git(root, ["show", `:${rel}`]);
  if (!staged.ok && !status) return null; // untracked and not staged: nothing committed to compare

  if (status && status !== "A") {
    // Modified, deleted, or changed type. Check the code against the requirements it was written to.
    const before = git(root, ["show", `HEAD:${rel}`]);
    return { rel, changed: status, text: before.ok ? before.out : "" };
  }
  const working = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  return { rel, changed: null, text: staged.out, unstaged: working !== staged.out };
}

/**
 * `taskText` and `baselineText` are kept apart as well as joined, because the gate reports which
 * sentences of each no check read, and says so differently for each.
 * @returns {{ text: string, taskText: string, baselineText: string, failures: string[], advisories: string[], baseline: string|null }}
 */
export function loadRequirements(projectDir, taskFile, { preCommit = false, baselineFile = null } = {}) {
  const failures = [];
  const advisories = [];
  let taskText = taskFile ? readFileSync(taskFile, "utf8") : "";

  if (taskFile && preCommit) {
    const c = taskAtCommit(taskFile);
    if (c) {
      taskText = c.text;
      if (c.changed) {
        const verb = c.changed === "D" ? "deletes" : "changes";
        failures.push(
          `task file: this commit ${verb} ${c.rel}, the requirements the gate checks the code against. ` +
            `A requirement is a person's decision, and it should not change in the same commit as the code it would let ` +
            `through — an agent blocked by a requirement can otherwise delete it and commit. The code was checked against ` +
            `the requirements as they were. If the change is intended, commit it on its own, deliberately: ` +
            `\`git commit --no-verify -- ${c.rel}\`.`
        );
      } else if (c.unstaged) {
        advisories.push(
          `task file: ${c.rel} has changes that are not part of this commit. The gate checked against the version being committed.`
        );
      }
    }
  }

  let baselineText = "";
  let baseline = null;
  if (baselineFile) {
    baseline = path.resolve(baselineFile);
    baselineText = readFileSync(baseline, "utf8");
    if (inside(real(projectDir), real(baseline))) {
      advisories.push(
        `baseline: ${path.relative(projectDir, baseline)} is inside the project, so whoever writes the code can edit it. ` +
          `A baseline is for requirements the project cannot opt out of; keep it somewhere the project's author cannot change.`
      );
    }
  }

  const text = [taskText, baselineText].filter((t) => t.trim()).join("\n\n");
  return { text, taskText, baselineText, failures, advisories, baseline };
}

export function checkBaselineInput(baselineFile) {
  if (!existsSync(baselineFile)) return `the baseline file ${baselineFile} does not exist`;
  if (!statSync(baselineFile).isFile()) return `the baseline file ${baselineFile} is not a file`;
  return null;
}
