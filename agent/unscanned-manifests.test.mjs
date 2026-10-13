import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import path from "path";

import { unscannedManifests, NEEDS_LOCKFILE } from "./unscanned-manifests.mjs";

function project(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "unscanned-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

function unscanned(files) {
  const dir = project(files);
  try {
    return unscannedManifests(dir).map((u) => u.manifest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NPM = '{"name":"p","version":"1.0.0","dependencies":{"lodash":"4.17.4"}}';

// The probe that found it: exit 0, no advisory, check_dependencies listed as having run.
test("a package.json with dependencies and no lockfile is unscanned", () => {
  assert.deepEqual(unscanned({ "package.json": NPM }), ["package.json"]);
});

test("each lockfile osv-scanner reads covers its manifest", () => {
  for (const lock of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock"]) {
    assert.deepEqual(unscanned({ "package.json": NPM, [lock]: "x" }), [], lock);
  }
});

test("bun.lockb does not cover a package.json, because osv-scanner cannot read it", () => {
  assert.deepEqual(unscanned({ "package.json": NPM, "bun.lockb": "x" }), ["package.json"]);
});

test("a manifest that declares nothing needs no lockfile", () => {
  // Blocking a package.json that only holds scripts would teach people to ignore the check.
  assert.deepEqual(
    unscanned({
      "package.json": '{"name":"p","scripts":{"test":"node --test"},"dependencies":{}}',
      "Cargo.toml": '[package]\nname="p"\nversion="0.1.0"\n\n[dependencies]\n',
      "py/pyproject.toml": '[project]\nname="p"\nversion="0.1"\ndependencies = []\n',
      "poetry/pyproject.toml": '[tool.poetry.dependencies]\npython = "^3.10"\n',
      "composer.json": '{"require":{"php":">=8.1","ext-json":"*"}}',
      "build.gradle": "plugins { id 'java' }\ndependencies {\n  // none yet\n}\n",
      Gemfile: "source 'https://rubygems.org'\n",
      Pipfile: '[packages]\n\n[requires]\npython_version = "3.12"\n',
    }),
    []
  );
});

test("every ecosystem with dependencies and no lockfile is reported", () => {
  const got = unscanned({
    "js/package.json": NPM,
    "rs/Cargo.toml": '[package]\nname="p"\n\n[dependencies]\nsmallvec = "=0.6.9"\n',
    "rs2/Cargo.toml": '[package]\nname="p"\n\n[dependencies.serde]\nversion = "1"\n',
    "pipenv/Pipfile": '[packages]\nrequests = "==2.19.0"\n',
    "pep621/pyproject.toml": '[project]\nname = "p"\ndependencies = [\n  "requests==2.19.0",\n]\n',
    "poetry/pyproject.toml": '[tool.poetry.dependencies]\npython = "^3.10"\nrequests = "2.19.0"\n',
    "groovy/build.gradle": "dependencies { implementation 'org.apache.logging.log4j:log4j-core:2.14.1' }\n",
    "kts/build.gradle.kts": 'dependencies { implementation("org.apache.logging.log4j:log4j-core:2.14.1") }\n',
    "rb/Gemfile": "source 'https://rubygems.org'\ngem 'rack', '2.0.1'\n",
    "php/composer.json": '{"require":{"guzzlehttp/guzzle":"6.5.7"}}',
  }).sort();
  assert.deepEqual(got, [
    "groovy/build.gradle", "js/package.json", "kts/build.gradle.kts", "pep621/pyproject.toml",
    "php/composer.json", "pipenv/Pipfile", "poetry/pyproject.toml", "rb/Gemfile", "rs/Cargo.toml",
    "rs2/Cargo.toml",
  ]);
});

test("a pyproject.toml is covered by a requirements*.txt, which osv-scanner reads, but not by requirements.lock", () => {
  const py = '[project]\nname="p"\ndependencies=["requests==2.19.0"]\n';
  assert.deepEqual(unscanned({ "pyproject.toml": py, "requirements-lock.txt": "requests==2.19.0\n" }), []);
  assert.deepEqual(unscanned({ "pyproject.toml": py, "requirements.txt": "requests==2.19.0\n" }), []);
  assert.deepEqual(unscanned({ "pyproject.toml": py, "requirements.lock": "requests==2.19.0\n" }), ["pyproject.toml"]);
});

test("a workspace lockfile at the root covers its members", () => {
  assert.deepEqual(unscanned({ "package-lock.json": "x", "packages/a/package.json": NPM }), []);
  assert.deepEqual(unscanned({ "Cargo.lock": "x", "crates/a/Cargo.toml": '[dependencies]\nserde = "1"\n' }), []);
});

test("a lockfile beside a different manifest does not cover this one", () => {
  // The project-wide "is there a lockfile anywhere" test would have passed this.
  assert.deepEqual(unscanned({ "api/poetry.lock": "x", "api/pyproject.toml": "", "web/package.json": NPM }), ["web/package.json"]);
});

test("an unparseable package.json is reported rather than assumed empty", () => {
  assert.deepEqual(unscanned({ "package.json": "{ not json" }), ["package.json"]);
});

test("installed dependencies are not the project's manifests", () => {
  assert.deepEqual(unscanned({ "package-lock.json": "x", "package.json": NPM, "node_modules/lodash/package.json": NPM }), []);
});

// The table above is a claim about osv-scanner, measured against 2.4.0. This holds it to the real
// scanner, so a version bump that changes what it reads fails here instead of making the table
// quietly wrong. CI sets AGENT_GATE_REQUIRE_SCANNERS so a missing scanner fails rather than skips.
const haveScanner = spawnSync("osv-scanner", ["--version"]).status === 0;
const required = process.env.AGENT_GATE_REQUIRE_SCANNERS === "1";

const LOCK_FIXTURES = {
  "package-lock.json": '{"name":"p","lockfileVersion":3,"packages":{"":{"name":"p"},"node_modules/lodash":{"version":"4.17.4"}}}',
  "npm-shrinkwrap.json": '{"name":"p","lockfileVersion":3,"packages":{"":{"name":"p"},"node_modules/lodash":{"version":"4.17.4"}}}',
  "yarn.lock": 'lodash@4.17.4:\n  version "4.17.4"\n  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.4.tgz"\n',
  "pnpm-lock.yaml": "lockfileVersion: '6.0'\npackages:\n  /lodash@4.17.4:\n    resolution: {integrity: sha512-x}\n",
  "bun.lock": '{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "p", "dependencies": { "lodash": "4.17.4" } } },\n  "packages": { "lodash": ["lodash@4.17.4", "", {}, "sha512-x"] }\n}\n',
  "Cargo.lock": 'version = 3\n\n[[package]]\nname = "smallvec"\nversion = "0.6.9"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
  "Pipfile.lock": '{"_meta":{"hash":{"sha256":"x"},"pipfile-spec":6,"requires":{},"sources":[{"name":"pypi","url":"https://pypi.org/simple","verify_ssl":true}]},"default":{"requests":{"hashes":[],"version":"==2.19.0"}},"develop":{}}',
  "poetry.lock": '[[package]]\nname = "requests"\nversion = "2.19.0"\ndescription = ""\noptional = false\npython-versions = "*"\n',
  "pdm.lock": '[[package]]\nname = "requests"\nversion = "2.19.0"\n',
  "uv.lock": 'version = 1\n\n[[package]]\nname = "requests"\nversion = "2.19.0"\nsource = { registry = "https://pypi.org/simple" }\n',
  "pylock.toml": 'lock-version = "1.0"\ncreated-by = "x"\n\n[[packages]]\nname = "requests"\nversion = "2.19.0"\n',
  "gradle.lockfile": "org.apache.logging.log4j:log4j-core:2.14.1=runtimeClasspath\nempty=\n",
  "Gemfile.lock": "GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.0.1)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  rack (= 2.0.1)\n\nBUNDLED WITH\n   2.4.10\n",
  "composer.lock": '{"packages":[{"name":"guzzlehttp/guzzle","version":"6.5.7"}],"packages-dev":[]}',
};

const MANIFEST_FIXTURES = {
  "package.json": NPM,
  "Cargo.toml": '[package]\nname="p"\nversion="0.1.0"\nedition="2021"\n\n[dependencies]\nsmallvec = "=0.6.9"\n',
  Pipfile: '[packages]\nrequests = "==2.19.0"\n',
  "pyproject.toml": '[project]\nname="p"\nversion="0.1"\ndependencies=["requests==2.19.0"]\n',
  "build.gradle": "plugins { id 'java' }\ndependencies { implementation 'org.apache.logging.log4j:log4j-core:2.14.1' }\n",
  "build.gradle.kts": 'plugins { java }\ndependencies { implementation("org.apache.logging.log4j:log4j-core:2.14.1") }\n',
  Gemfile: "source 'https://rubygems.org'\ngem 'rack', '2.0.1'\n",
  "composer.json": '{"require":{"guzzlehttp/guzzle":"6.5.7"}}',
};

function osvReads(name, body) {
  const dir = project({ [name]: body });
  try {
    const r = spawnSync("osv-scanner", ["scan", "source", "-r", dir, "--format", "json"], { encoding: "utf8", timeout: 120_000 });
    return { read: r.stderr.includes(`Scanned ${path.join(dir, name)} file`), status: r.status, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const scannerTest = (name, fn) =>
  test(name, { skip: !haveScanner && !required && "osv-scanner not installed" }, () => {
    assert.ok(haveScanner, "AGENT_GATE_REQUIRE_SCANNERS is set and osv-scanner is not on PATH");
    fn();
  });

scannerTest("osv-scanner reads none of these manifests on its own", () => {
  assert.deepEqual(Object.keys(MANIFEST_FIXTURES).sort(), Object.keys(NEEDS_LOCKFILE).sort(), "a fixture for every manifest in the table");
  for (const [name, body] of Object.entries(MANIFEST_FIXTURES)) {
    const r = osvReads(name, body);
    assert.equal(r.read, false, `osv-scanner now reads ${name} — it no longer needs a lockfile, and the table is wrong`);
  }
});

scannerTest("osv-scanner reads every lockfile the table accepts", () => {
  const accepted = new Set(Object.values(NEEDS_LOCKFILE).flatMap((r) => r.locks));
  assert.deepEqual([...accepted].sort(), Object.keys(LOCK_FIXTURES).sort(), "a fixture for every accepted lockfile");
  for (const [name, body] of Object.entries(LOCK_FIXTURES)) {
    const r = osvReads(name, body);
    assert.ok(r.read, `osv-scanner did not read ${name} (exit ${r.status}): ${r.stderr.slice(-300)}`);
  }
});

scannerTest("osv-scanner does not read bun.lockb or requirements.lock, which is why the table refuses them", () => {
  assert.equal(osvReads("bun.lockb", "binary").read, false);
  assert.equal(osvReads("requirements.lock", "requests==2.19.0\n").read, false);
  assert.equal(osvReads("requirements-lock.txt", "requests==2.19.0\n").read, true);
});
