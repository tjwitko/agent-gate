import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { sourceCoverage, coverageLine } from "./coverage.mjs";

function cov(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "coverage-"));
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), body);
    }
    return sourceCoverage(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The probe: a Rust project exited 0, and the only sign none of its code was read was one advisory
// among several.
test("a project written in a language nothing reads says so, loudly", () => {
  // Rust is read now (agent/sast-rules/rust.yaml); PHP is the example of a language nothing reads.
  const c = cov({ "composer.json": "{}\n", "src/index.php": "<?php\n", "src/lib.php": "<?php\n" });
  assert.deepEqual(c.unread, [{ language: "PHP", files: 2 }]);
  assert.equal(c.mostlyUnread, true);
  assert.match(coverageLine(c), /^MOST OF THIS PROJECT'S SOURCE WAS NOT READ: 2 PHP file\(s\), against 0/);
});

test("a minority of unread files is still named, without the capitals", () => {
  const c = cov({ "app.py": "\n", "server.py": "\n", "mobile/Main.kt": "\n" });
  assert.equal(c.mostlyUnread, false);
  assert.match(coverageLine(c), /^1 Kotlin file\(s\) were not read/);
});

test("a project entirely in languages the checks read gets no line", () => {
  assert.equal(coverageLine(cov({ "index.js": "\n", "app.py": "\n", "main.tf": "\n", "run.sh": "\n" })), null);
});

test("installed dependencies are not the project's source; vendored code is", () => {
  const c = cov({ "index.js": "\n", "node_modules/native/binding.php": "\n", "vendor/x.php": "\n" });
  assert.deepEqual(c.unread, [{ language: "PHP", files: 1 }]);
});

test("languages the injection rules read are not called unread", () => {
  const c = cov({ "main.rs": "\n", "Program.cs": "\n", "server.c": "\n", "lib.cpp": "\n", "App.jsx": "\n" });
  assert.deepEqual(c.unread, []);
  assert.equal(coverageLine(c), null);
});
