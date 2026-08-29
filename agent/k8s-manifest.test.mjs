import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { checkK8sManifests, k8sManifestFailures } from "./k8s-manifest.mjs";

function run(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "k8s-"));
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

const APP_WITH_HEALTH = '@app.get("/health")\ndef health():\n    return {"status": "ok"}\n';

function deployment({ resourcesAtPodLevel = false, probe = false, annotation = null } = {}) {
  const container =
    '      - name: receiver\n' +
    '        image: repo/img:latest\n' +
    '        ports:\n        - containerPort: 8000\n' +
    (probe
      ? '        readinessProbe:\n          httpGet:\n            path: /health\n            port: 8000\n'
      : "") +
    (resourcesAtPodLevel ? "" : '        resources:\n          requests:\n            cpu: "100m"\n');
  return (
    "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: webhook-receiver\nspec:\n" +
    "  template:\n" +
    (annotation ? `    metadata:\n      annotations:\n        role-arn: ${annotation}\n` : "") +
    "    spec:\n      containers:\n" +
    container +
    (resourcesAtPodLevel ? '      resources:\n        requests:\n          cpu: "100m"\n' : "")
  );
}

test("a container field on the pod spec fails — the object would be rejected outright", () => {
  const { failures } = run(
    { "k8s/deployment.yaml": deployment({ resourcesAtPodLevel: true, probe: true }), "app/main.py": APP_WITH_HEALTH },
    k8sManifestFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /"resources" on the pod spec/);
  assert.match(failures[0], /does\s+not deploy at all/);
});

test("the same field inside the container is clean", () => {
  const { failures } = run(
    { "k8s/deployment.yaml": deployment({ probe: true }), "app/main.py": APP_WITH_HEALTH },
    k8sManifestFailures
  );
  assert.deepEqual(failures, []);
});

test("${...} interpolation fails — Kubernetes never expands it", () => {
  const { failures } = run(
    {
      "k8s/deployment.yaml": deployment({ probe: true, annotation: "arn:aws:iam::${var.account_id}:role/app" }),
      "app/main.py": APP_WITH_HEALTH,
    },
    k8sManifestFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /never expands/);
});

// Kubernetes DOES substitute $(VAR) in container env and command. Flagging it would be a false
// positive on the one interpolation form that actually works.
test("$(VAR) is left alone", () => {
  const yaml =
    "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\nspec:\n  template:\n    spec:\n" +
    "      containers:\n      - name: c\n        image: i\n        env:\n" +
    "        - name: URL\n          value: http://$(HOST):8080\n" +
    "        readinessProbe:\n          httpGet:\n            path: /health\n            port: 8000\n";
  const { failures } = run({ "k8s/d.yaml": yaml, "app/main.py": APP_WITH_HEALTH }, k8sManifestFailures);
  assert.deepEqual(failures, []);
});

test("a health endpoint with no probe wired to it fails", () => {
  const { failures } = run(
    { "k8s/deployment.yaml": deployment({ probe: false }), "app/main.py": APP_WITH_HEALTH },
    k8sManifestFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no liveness, readiness or startup probe/);
});

test("a readinessProbe satisfies it", () => {
  const { failures } = run(
    { "k8s/deployment.yaml": deployment({ probe: true }), "app/main.py": APP_WITH_HEALTH },
    k8sManifestFailures
  );
  assert.deepEqual(failures, []);
});

// The probe finding needs a target. An app with no health endpoint is not required to grow one.
test("no health endpoint means no probe finding", () => {
  const { failures } = run(
    { "k8s/deployment.yaml": deployment({ probe: false }), "app/main.py": '@app.get("/logs")\ndef logs():\n    pass\n' },
    k8sManifestFailures
  );
  assert.deepEqual(failures, []);
});

// A batch task that exits is supposed to have no readiness probe.
test("a Job is exempt from the probe check", () => {
  const yaml =
    "apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: j\nspec:\n  template:\n    spec:\n" +
    "      containers:\n      - name: c\n        image: i\n";
  const { failures } = run({ "k8s/j.yaml": yaml, "app/main.py": APP_WITH_HEALTH }, k8sManifestFailures);
  assert.deepEqual(failures, []);
});

// Silence must never read as success.
test("no manifests is reported as not-checked, never as a pass", () => {
  const { failures, advisories } = run({ "app/main.py": APP_WITH_HEALTH }, k8sManifestFailures);
  assert.deepEqual(failures, []);
  assert.equal(advisories.length, 1);
  assert.match(advisories[0], /not checked/);
});

test("a CronJob's nested pod spec is still read for misplaced fields", () => {
  const yaml =
    "apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: c\nspec:\n  schedule: '* * * * *'\n" +
    "  jobTemplate:\n    spec:\n      template:\n        spec:\n          containers:\n" +
    "          - name: c\n            image: i\n          image: wrong\n";
  const { misplaced } = run({ "k8s/c.yaml": yaml }, checkK8sManifests);
  assert.equal(misplaced.length, 1);
  assert.equal(misplaced[0].field, "image");
});

// A probe is a container field, and CONTAINER_ONLY_FIELDS in this same module flags container
// fields found on the pod spec. A remediation that said "add a readinessProbe" without saying where
// could induce the very defect its sibling check catches.
test("the probe remediation shows the probe inside the container", () => {
  const { failures } = run(
    { "k8s/deployment.yaml": deployment({ probe: false }), "app/main.py": APP_WITH_HEALTH },
    k8sManifestFailures
  );
  assert.match(failures[0], /CONTAINER field, not a pod-spec one/);
  assert.match(failures[0], /containers:[\s\S]*readinessProbe:[\s\S]*httpGet:/);
});
