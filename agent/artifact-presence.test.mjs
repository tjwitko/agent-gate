import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  checkArtifactPresence,
  artifactPresenceFailures,
  artifactInventory,
  artifactRegressions,
} from "./artifact-presence.mjs";

function run(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "artifact-"));
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

const TASK = "Kubernetes manifests for the service. A Dockerfile for the container image. Terraform for all infrastructure.";
const REAL_MANIFEST = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\n";
const REAL_DOCKERFILE = "FROM python:3.11-slim\nCMD [\"python\", \"app.py\"]\n";
const REAL_TF = 'resource "aws_s3_bucket" "b" {\n  bucket = "x"\n}\n';

// The webhook-10 case: five manifests written back as empty files, three checks silenced at once.
test("an emptied manifest is a finding, not a pass", () => {
  const { failures } = run(
    { "k8s/deployment.yaml": "", "k8s/service.yaml": "", "Dockerfile": REAL_DOCKERFILE, "main.tf": REAL_TF },
    (d) => artifactPresenceFailures(d, TASK)
  );
  const empty = failures.find((f) => /exist but are empty/.test(f));
  assert.ok(empty);
  assert.match(empty, /k8s\/deployment\.yaml/);
  assert.match(empty, /absence of the work wearing/);
});

test("whitespace-only counts as empty", () => {
  const { empty } = run({ "k8s/deployment.yaml": "\n  \n\t\n" }, (d) => checkArtifactPresence(d, TASK));
  assert.equal(empty.length, 1);
});

// Some files are legitimately empty and must not be flagged.
test("__init__.py, .gitkeep and .gitignore are left alone", () => {
  const { empty } = run(
    { "app/__init__.py": "", ".gitkeep": "", ".gitignore": "", "app/main.py": "print(1)\n" },
    (d) => checkArtifactPresence(d, TASK)
  );
  assert.deepEqual(empty.map((e) => e.rel), []);
});

test("a task-required artifact class that is absent is reported", () => {
  const { failures } = run({ "app/main.py": "print(1)\n" }, (d) => artifactPresenceFailures(d, TASK));
  const missing = failures.find((f) => /the task asks for/.test(f));
  assert.ok(missing);
  assert.match(missing, /Kubernetes manifests/);
  assert.match(missing, /a Dockerfile/);
  assert.match(missing, /Terraform configuration/);
});

// Checked by content, not by filename — a .yaml with no `kind:` is not a manifest.
test("a yaml without kind does not satisfy the Kubernetes requirement", () => {
  const { missing } = run(
    { "k8s/values.yaml": "replicas: 2\nimage: app\n", "Dockerfile": REAL_DOCKERFILE, "main.tf": REAL_TF },
    (d) => checkArtifactPresence(d, TASK)
  );
  assert.deepEqual(missing.map((m) => m.id), ["kubernetes"]);
});

test("a complete project is clean", () => {
  const { failures } = run(
    { "k8s/deployment.yaml": REAL_MANIFEST, "Dockerfile": REAL_DOCKERFILE, "terraform/main.tf": REAL_TF },
    (d) => artifactPresenceFailures(d, TASK)
  );
  assert.deepEqual(failures, []);
});

// A requirement the task never states must not be invented.
test("no Kubernetes requirement means no Kubernetes finding", () => {
  const { missing } = run({ "app/main.py": "print(1)\n" }, (d) =>
    checkArtifactPresence(d, "Write a script that prints hello.")
  );
  assert.deepEqual(missing, []);
});

// --- the in-run artifact census ------------------------------------------------------------------
test("content lost between rounds is reported", () => {
  const before = new Map([["k8s/deployment.yaml", 900], ["src/main.py", 2000]]);
  const after = new Map([["src/main.py", 2100]]);
  const lost = artifactRegressions(before, after);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].rel, "k8s/deployment.yaml");
  assert.equal(lost[0].now, "gone");
});

test("a file gutted to a fraction of its size is reported even though it still exists", () => {
  const lost = artifactRegressions(new Map([["a.tf", 1000]]), new Map([["a.tf", 30]]));
  assert.equal(lost.length, 1);
  assert.equal(lost[0].now, 30);
});

test("ordinary edits and growth are not regressions", () => {
  assert.deepEqual(artifactRegressions(new Map([["a.tf", 1000]]), new Map([["a.tf", 1400]])), []);
  assert.deepEqual(artifactRegressions(new Map([["a.tf", 1000]]), new Map([["a.tf", 850]])), []);
});

test("the first round has nothing to compare against", () => {
  assert.deepEqual(artifactRegressions(null, new Map([["a.tf", 10]])), []);
});

test("the inventory excludes empty files", () => {
  const inv = run({ "a.tf": REAL_TF, "b.tf": "" }, artifactInventory);
  assert.deepEqual([...inv.keys()], ["a.tf"]);
});

// The remediation must name an action the model can actually perform. It previously said "delete
// the file" when the tool set had no delete_file, which is a remediation asking for an impossible
// action — the same defect class as naming a setting without naming the block it lives in.
test("the empty-file remediation names a tool that exists", () => {
  const { failures } = run(
    { "k8s/deployment.yaml": "", "Dockerfile": REAL_DOCKERFILE, "main.tf": REAL_TF },
    (d) => artifactPresenceFailures(d, TASK)
  );
  assert.match(failures[0], /delete_file/);
});

// --- the task's wording, not the tool's name ------------------------------
// Three requirements were recognised only when the task named the tool this project checks for:
// three of four rephrasings of the same deployment requirement produced no finding at all. That
// matters more here than in the two gates already fixed, because manifest-contract and iam-contract
// both return nothing on a project with nothing to read -- defensible on their own terms, and safe
// only because artifact-presence is the net that catches "nothing was produced". A missed trigger
// puts a hole in that net in exactly the case it exists to cover: a model that wrote all five
// manifests back as empty files, dropping blocking failures 5 -> 2 while three manifest-aware gates
// went quiet.
const README_ONLY = { "README.md": "# service\n" };

const REPHRASINGS = [
  "Kubernetes manifests for the service. Terraform for all infrastructure. A Dockerfile for the container image.",
  "Deploy to EKS with Helm charts and infrastructure as code",
  "Ship it as a container, declare the cloud resources, and give me the deployment specs",
  "Deploy the service to our cluster using our standard IaC tooling",
  "Package the service in a container and provision the AWS resources with OpenTofu",
  "Give me the k8s manifests, a Dockerfile, and HCL for the infrastructure",
  "Containerise it, write the pod specs, and define the cloud resources as code",
];

for (const task of REPHRASINGS) {
  test(`a deployment requirement survives being rephrased: ${task.slice(0, 44)}`, () => {
    const { failures } = run(README_ONLY, (d) => artifactPresenceFailures(d, task));
    assert.ok(failures.length > 0, `no finding for: ${task}`);
  });
}

// This gate BLOCKS, so a trigger that fires wrongly makes a correct project fail for missing an
// artifact nobody asked for. These name no artifact and must stay silent.
const NAMES_NO_ARTIFACT = [
  "Build a REST API for managing users",
  "Deploy the service",                       // bare deploy implies nothing
  "Store the records in a database",
  // Decided deliberately: a bare cluster is equally an ECS, Nomad, Spark or database cluster, and
  // demanding Kubernetes manifests for one of those is a false block. A task that means Kubernetes
  // says EKS, Helm, kubectl or Kubernetes.
  "Run it on our existing cluster",
  "Send the results to the cloud",
  "Roll out the change to production",
];

for (const task of NAMES_NO_ARTIFACT) {
  test(`a wider vocabulary does not invent a requirement: ${task.slice(0, 44)}`, () => {
    const { failures } = run(README_ONLY, (d) => artifactPresenceFailures(d, task));
    assert.deepEqual(failures, [], `invented a requirement from: ${task}`);
  });
}

// Trap: `.*` in the old kubernetes pattern crossed sentence boundaries, so a task naming manifests
// in one paragraph and a service in another matched.
test("proximity does not reach across a sentence or a semicolon", () => {
  const task =
    "Write the deployment manifests for our internal tooling. The service itself is out of scope; " +
    "another team owns the cluster.";
  const { failures } = run(README_ONLY, (d) => artifactPresenceFailures(d, task));
  assert.deepEqual(failures, []);
});

// Trap: /\bcontainer\b/ against "containers" is fine, but a noun list without its own `s?` is not.
test("plural nouns match", () => {
  const { failures } = run(README_ONLY, (d) =>
    artifactPresenceFailures(d, "Ship the services as containers")
  );
  assert.ok(failures.length > 0);
});
