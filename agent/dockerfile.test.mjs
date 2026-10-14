import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import path from "path";

import { dockerfileFailures, findDockerfiles, baseImages, imageEol, parseRef } from "./dockerfile.mjs";
import { EOL, PRODUCTS } from "./eol-data.mjs";

const NOW = { AGENT_GATE_TODAY: "2026-10-13" };

function check(files, { env = NOW, checkov = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "dockerfile-"));
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), body);
    }
    return { ...dockerfileFailures(dir, { env, checkov }), found: findDockerfiles(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The review's example, which passed: artifact_presence confirmed the file existed and nothing read it.
test("FROM node:14 blocks, naming the release, its end-of-life date and what is supported", () => {
  const r = check({ Dockerfile: 'FROM node:14\nCOPY . .\nCMD ["node", "index.js"]\n' });
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /Dockerfile builds on a base image past end of life/);
  assert.match(r.failures[0], /line 1 FROM node:14: Node\.js 14 reached end of life on 2023-04-30/);
  assert.match(r.failures[0], /Supported: Node\.js \d+ or \d+/);
});

test("a supported base image passes", () => {
  assert.deepEqual(check({ Dockerfile: "FROM node:24-alpine\nCOPY . .\n" }).failures, []);
});

test("every stage is judged, as one finding per Dockerfile", () => {
  const r = check({
    Dockerfile:
      "FROM golang:1.21-alpine AS builder\nRUN go build -o /app .\n\n" +
      "FROM alpine:3.18\nCOPY --from=builder /app /app\n",
  });
  assert.equal(r.failures.length, 1, "two stages, one mistake made twice, one finding");
  assert.match(r.failures[0], /2 base images/);
  assert.match(r.failures[0], /line 1 FROM golang:1\.21-alpine \(stage builder\): Go 1\.21/);
  assert.match(r.failures[0], /line 4 FROM alpine:3\.18: Alpine Linux 3\.18/);
  assert.match(r.failures[0], /A build stage counts/);
});

test("the build-stage note appears only when a build stage is the one past end of life", () => {
  const r = check({ Dockerfile: "FROM golang:1.26 AS builder\nRUN true\nFROM alpine:3.18\n" });
  assert.equal(r.failures.length, 1);
  assert.doesNotMatch(r.failures[0], /A build stage counts/);
});

test("a FROM naming an earlier stage, and scratch, are not images", () => {
  const images = baseImages("FROM node:24 AS deps\nFROM deps AS build\nFROM scratch\nFROM node:24 AS node\n");
  assert.deepEqual(images.map((i) => i.ref), ["node:24", "node:24"]);
});

test("ARG defaults are substituted; a variable with none is reported, not guessed", () => {
  assert.equal(check({ Dockerfile: "ARG NODE_VERSION=16\nFROM node:${NODE_VERSION}-alpine\n" }).failures.length, 1);
  const r = check({ Dockerfile: "ARG NODE_VERSION\nFROM node:${NODE_VERSION}\n" });
  assert.deepEqual(r.failures, []);
  assert.match(r.advisories.join("\n"), /could not be judged for end of life — Dockerfile:2 node:\$\{NODE_VERSION\}/);
});

test("the OS under a language image is judged too", () => {
  assert.deepEqual(imageEol("python:3.12-slim-buster", "2026-10-13").map((e) => e.label), ["Debian 10 (buster), the OS under it"]);
  assert.deepEqual(imageEol("eclipse-temurin:11-jdk-focal", "2026-10-13").map((e) => e.label), ["Ubuntu 20.04 (focal), the OS under it"]);
  assert.deepEqual(imageEol("golang:1.22-alpine3.19", "2026-10-13").map((e) => e.label), ["Go 1.22", "Alpine Linux 3.19, the OS under it"]);
});

test("Debian and Ubuntu are judged by codename or number", () => {
  assert.equal(imageEol("debian:buster-slim", "2026-10-13").length, 1);
  assert.equal(imageEol("debian:10", "2026-10-13").length, 1);
  assert.equal(imageEol("ubuntu:focal", "2026-10-13").length, 1);
  assert.deepEqual(imageEol("debian:bookworm", "2026-10-13"), []);
});

test("floating tags and other publishers' images are not judged", () => {
  for (const ref of ["node:lts", "node:latest", "node", "python:3", "bitnami/node:14", "myorg/python:3.6"]) {
    assert.deepEqual(imageEol(ref, "2026-10-13"), [], ref);
  }
});

test("registry prefixes and digests are seen through", () => {
  assert.deepEqual(parseRef("docker.io/library/node:16@sha256:abc"), { repo: "node", tag: "16" });
  assert.deepEqual(parseRef("public.ecr.aws/docker/library/python:3.9-slim"), { repo: "python", tag: "3.9-slim" });
  assert.deepEqual(parseRef("localhost:5000/node:16"), { repo: "localhost:5000/node", tag: "16" });
});

// The corpus pins this, so a frozen verdict does not move on the day a release ages out.
test("judged as of AGENT_GATE_TODAY: the end-of-life date itself is the first day without support", () => {
  const df = { Dockerfile: "FROM node:20-alpine\n" };
  assert.deepEqual(check(df, { env: { AGENT_GATE_TODAY: "2026-04-29" } }).failures, []);
  assert.equal(check(df, { env: { AGENT_GATE_TODAY: "2026-04-30" } }).failures.length, 1);
});

test("Containerfile and *.Dockerfile are read; installed dependencies are not", () => {
  const r = check({
    Containerfile: "FROM node:14\n",
    "api.Dockerfile": "FROM node:14\n",
    "Dockerfile.dev": "FROM node:14\n",
    "node_modules/x/Dockerfile": "FROM node:14\n",
  });
  assert.deepEqual(r.found, ["Containerfile", "Dockerfile.dev", "api.Dockerfile"]);
  assert.equal(r.failures.length, 3);
});

test("a project with no Dockerfile reports nothing", () => {
  assert.deepEqual(check({ "index.js": "\n" }), { failures: [], advisories: [], found: [] });
});

test("the generated table is complete and well-formed", () => {
  for (const repo of Object.keys(PRODUCTS)) {
    assert.ok(EOL[repo]?.length > 3, `${repo} has cycles`);
    for (const c of EOL[repo]) {
      assert.ok(c.eol === true || c.eol === false || /^\d{4}-\d{2}-\d{2}$/.test(c.eol), `${repo} ${c.cycle}: ${c.eol}`);
    }
  }
});

// checkov's rules are advisories, never findings: most real Dockerfiles miss a HEALTHCHECK.
const haveCheckov = spawnSync("checkov", ["--version"]).status === 0;
test("checkov's Dockerfile rules are advisories", { skip: !haveCheckov && "checkov not installed" }, () => {
  const r = check({ Dockerfile: "FROM node:24-alpine\nCOPY . .\n" }, { checkov: true });
  assert.deepEqual(r.failures, []);
  assert.match(r.advisories.join("\n"), /checkov reports \d+ finding\(s\) — not blocking\. Dockerfile: .*CKV_DOCKER_3/);
});

test("without checkov, the advisory says which rules did not run", () => {
  // A child process whose PATH holds node and nothing else, so checkov is absent whatever this
  // machine has installed.
  const bin = mkdtempSync(path.join(tmpdir(), "nocheckov-"));
  const dir = mkdtempSync(path.join(tmpdir(), "dockerfile-"));
  try {
    spawnSync("ln", ["-s", process.execPath, path.join(bin, "node")]);
    writeFileSync(path.join(dir, "Dockerfile"), "FROM node:24-alpine\n");
    const src = `import { dockerfileFailures } from ${JSON.stringify(new URL("./dockerfile.mjs", import.meta.url).href)};
      console.log(JSON.stringify(dockerfileFailures(${JSON.stringify(dir)})));`;
    const r = spawnSync(path.join(bin, "node"), ["--input-type=module", "-e", src], { encoding: "utf8", env: { PATH: bin, AGENT_GATE_TODAY: "2026-10-13" } });
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.failures, []);
    assert.match(out.advisories.join("\n"), /checkov is not installed, so 1 Dockerfile\(s\) were checked for end-of-life base images only/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
