import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// The calibration run itself is the check on the counts; it clones, so it runs in its own workflow.
// These hold the manifest to what that run relies on, offline.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(__dirname, "manifest.json"), "utf8"));

test("every app is pinned to a full commit and was measured there", () => {
  for (const app of manifest.apps) {
    assert.match(app.commit, /^[0-9a-f]{40}$/, `${app.name}: a branch or short SHA can move under the counts`);
    assert.match(app.repo, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/, app.name);
    assert.ok(app.expected && app.expected.files > 0, `${app.name}: never measured`);
    const sum = (k) => Object.values(app.expected.byRule).reduce((n, r) => n + r[k], 0);
    assert.equal(sum("blocking"), app.expected.blocking, `${app.name}: per-rule blocking counts do not add up`);
    assert.equal(sum("advisory"), app.expected.advisory, `${app.name}: per-rule advisory counts do not add up`);
  }
});

test("an app listed as having findings has blocking ones; the gaps are named, not implied", () => {
  const positives = manifest.apps.filter((a) => a.role === "findings");
  for (const a of positives) assert.ok(a.expected.blocking > 0, `${a.name} is a positive control with nothing blocking`);
  // Every language the rules block in, minus those with a positive control, is exactly the list of
  // languages the manifest says it cannot vouch for.
  const covered = new Set(positives.map((a) => a.language));
  const blockingLanguages = ["Python", "JavaScript/TypeScript", "Go", "Java", "Ruby", "C#", "Rust", "C", "C++"];
  const uncovered = blockingLanguages.filter((l) => !covered.has(l) && !(["C", "C++"].includes(l) && covered.has("C/C++")));
  assert.deepEqual(uncovered.sort(), Object.keys(manifest.noPositiveControl).sort());
});

test("every language with an app has a clean one, except C++, which is named as having none", () => {
  const clean = new Set(manifest.apps.filter((a) => a.role === "clean").map((a) => a.language));
  for (const l of ["Python", "JavaScript/TypeScript", "Go", "Java", "Ruby", "C#", "Rust", "C/C++"]) assert.ok(clean.has(l), l);
  assert.match(manifest.noPositiveControl["C++"], /no C\+\+ app at all/);
});

test("the semgrep the counts were measured with is the one CI installs for the gate", () => {
  const tooling = readFileSync(path.join(__dirname, "..", ".github", "actions", "control-tooling", "action.yml"), "utf8");
  assert.match(tooling, new RegExp(`semgrep==${manifest.semgrep.replace(/\./g, "\\.")}\\b`));
  assert.equal(manifest.toolchain.semgrep, manifest.semgrep, "measured with a semgrep other than the pin");
});

test("nothing from the apps lives in this repository", () => {
  // Their URL and commit only. Copying would trip push protection, fire this repository's own gate,
  // and bring their licences with it.
  assert.deepEqual(readdirSync(__dirname).sort(), ["manifest.json", "manifest.test.mjs", "run.mjs"]);
});
