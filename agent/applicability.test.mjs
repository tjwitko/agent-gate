import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { validateProject } from "./agent-loop.mjs";

function project(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "applicability-"));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tools = (names) => new Map(names.map((n) => [n, { kind: "mcp", server: null, toolName: n }]));

/**
 * A tool with nothing to examine is not a tool that failed to run.
 *
 * The silent-control check exists because identity-guard sat spawned and unasked through ten
 * graded runs while a similarly-named in-process check ran beside it. That check is right and
 * stays. What it got wrong was scope: terraform_plan is never called on a project with no
 * Terraform, which is most projects, and every one of them came back INCOMPLETE. A gate that
 * reports "could not run" on ordinary work gets switched off, which costs more than the silence it
 * was guarding against.
 */
test("no Terraform means terraform_plan is out of scope, not missing", async () => {
  await project({ "package.json": "{}", "src/a.mjs": "export const x = 1;\n" }, async (dir) => {
    const r = await validateProject(dir, tools([]), "");
    assert.ok(
      r.inapplicable.some((i) => i.tool === "terraform_plan"),
      "terraform_plan must be reported as out of scope"
    );
    assert.match(r.inapplicable.find((i) => i.tool === "terraform_plan").why, /no Terraform/i);
  });
});

test("Terraform present means terraform_plan is in scope", async () => {
  await project(
    {
      "package.json": "{}",
      "main.tf": 'resource "null_resource" "a" {}\n',
    },
    async (dir) => {
      const r = await validateProject(dir, tools([]), "");
      assert.ok(
        !r.inapplicable.some((i) => i.tool === "terraform_plan"),
        "a project with .tf files must still be expected to plan"
      );
    }
  );
});

test("no dependency manifest means check_dependencies is out of scope", async () => {
  await project({ "src/a.mjs": "export const x = 1;\n" }, async (dir) => {
    const r = await validateProject(dir, tools([]), "");
    assert.ok(r.inapplicable.some((i) => i.tool === "check_dependencies"));
  });
});

test("a dependency manifest means check_dependencies is in scope", async () => {
  await project({ "package.json": '{"name":"x"}' }, async (dir) => {
    const r = await validateProject(dir, tools([]), "");
    assert.ok(
      !r.inapplicable.some((i) => i.tool === "check_dependencies"),
      "a project with a manifest must still be expected to have its dependencies scanned"
    );
  });
});

// The manifest search is recursive on purpose: the layout is the project's choice, and one
// deliverable put requirements.txt under app/. A root-only check would call the scan "not needed"
// rather than missed.
test("a manifest in a subdirectory keeps check_dependencies in scope", async () => {
  await project({ "app/requirements.txt": "flask==3.0.0\n" }, async (dir) => {
    const r = await validateProject(dir, tools([]), "");
    assert.ok(!r.inapplicable.some((i) => i.tool === "check_dependencies"));
  });
});
