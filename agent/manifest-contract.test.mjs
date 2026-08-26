import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { checkManifestContract, manifestContractFailures } from "./manifest-contract.mjs";

function run(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "contract-"));
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

const deployment = (envNames) =>
  "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: svc\nspec:\n  template:\n    spec:\n" +
  "      containers:\n      - name: svc\n        image: svc:latest\n" +
  (envNames.length ? "        env:\n" + envNames.map((n) => `        - name: ${n}\n          value: "x"\n`).join("") : "");

// The failure this exists for: a webhook receiver authenticated both routes, passed the auth gate,
// and served every stored callback to an unauthenticated request because its Deployment never set
// SUPPORT_API_KEY. Each artifact was correct alone; the defect lived only in the gap.
test("a variable the code requires and no manifest supplies is a failure", () => {
  const { failures } = run(
    {
      "src/main.py": 'import os\nS3 = os.getenv("S3_BUCKET")\nKEY = os.getenv("SUPPORT_API_KEY")\n',
      "k8s/deployment.yaml": deployment(["S3_BUCKET"]),
    },
    manifestContractFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /SUPPORT_API_KEY/);
  assert.doesNotMatch(failures[0], /S3_BUCKET \(/, "the supplied one is not reported");
});

test("a fully supplied contract passes", () => {
  const { failures } = run(
    {
      "src/main.py": 'import os\nS3 = os.getenv("S3_BUCKET")\nKEY = os.environ["API_KEY"]\n',
      "k8s/deployment.yaml": deployment(["S3_BUCKET", "API_KEY"]),
    },
    manifestContractFailures
  );
  assert.deepEqual(failures, []);
});

// A default means the variable is optional by construction, so its absence is not a contract gap.
test("a read with a default is not required", () => {
  const { failures } = run(
    {
      "src/main.py": 'import os\nREGION = os.getenv("MY_REGION", "us-east-1")\n',
      "k8s/deployment.yaml": deployment([]),
    },
    manifestContractFailures
  );
  assert.deepEqual(failures, []);
});

// `- name:` also appears on containers, volumes and ports. Matching it as text rather than walking
// the parsed document would treat the container's own name as a supplied variable and hide a gap.
test("a container name is not mistaken for an environment variable", () => {
  const { missing } = run(
    {
      "src/main.py": 'import os\nX = os.getenv("svc")\nY = os.getenv("REAL_VAR")\n',
      "k8s/deployment.yaml": deployment([]),
    },
    checkManifestContract
  );
  assert.deepEqual(missing.map((m) => m.name), ["REAL_VAR"]);
});

// Workloads are declared through Terraform's kubernetes provider as often as through YAML in these
// projects, sometimes both in one repo.
test("a Terraform-declared workload counts as supplying its env", () => {
  const { failures } = run(
    {
      "app/main.py": 'import os\nDB = os.getenv("DATABASE_URL")\n',
      "terraform/k8s.tf":
        'resource "kubernetes_deployment" "svc" {\n  spec {\n    template {\n      spec {\n' +
        "        container {\n          env {\n            name  = \"DATABASE_URL\"\n" +
        '            value = "postgres://..."\n          }\n        }\n      }\n    }\n  }\n}\n',
    },
    manifestContractFailures
  );
  assert.deepEqual(failures, []);
});

// envFrom pulls a whole ConfigMap or Secret whose keys are not in the manifest. An undetermined
// answer is an advisory, never a pass -- every silent-success bug in this stack came from a check
// that could not run saying nothing.
test("envFrom makes the contract unknowable, and it says so", () => {
  const { failures, advisories } = run(
    {
      "src/main.py": 'import os\nK = os.getenv("SOME_KEY")\n',
      "k8s/deployment.yaml":
        "apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n" +
        "      - name: svc\n        envFrom:\n        - secretRef:\n            name: app-secrets\n",
    },
    manifestContractFailures
  );
  assert.deepEqual(failures, []);
  assert.equal(advisories.length, 1);
  assert.match(advisories[0], /Secret\/app-secrets/);
});

test("no workload at all is reported, not passed", () => {
  const { failures, advisories } = run(
    { "src/main.py": 'import os\nK = os.getenv("SOME_KEY")\n' },
    manifestContractFailures
  );
  assert.deepEqual(failures, []);
  assert.match(advisories[0], /no Kubernetes workload was found/);
});

// Injected by the platform or by IRSA, not by the manifest author.
test("platform-provided variables are not reported as missing", () => {
  const { failures } = run(
    {
      "src/main.py":
        'import os\nR = os.getenv("AWS_REGION")\nA = os.getenv("AWS_ROLE_ARN")\nH = os.getenv("HOSTNAME")\n',
      "k8s/deployment.yaml": deployment([]),
    },
    manifestContractFailures
  );
  assert.deepEqual(failures, []);
});
