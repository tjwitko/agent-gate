// Kubernetes manifests that are valid YAML but not valid Kubernetes.
//
// Every check here failed to exist when webhook-5 was graded, and each corresponds to a defect
// that made the deliverable non-functional while every gate reported the manifests fine. The
// common property: the YAML parses, each file reads plausibly on its own, and the defect is only
// visible against the Kubernetes object schema or against the application source next to it.
//
// Deliberately NOT a full schema validator. A real one needs the API server's OpenAPI schema for
// the cluster version in play, which this loop has no access to. These are the three failure
// shapes actually observed, checked precisely, rather than a partial schema check that would be
// wrong in unpredictable ways.

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { parseAllDocuments } from "yaml";
import { SKIP_DIRS } from "./skip-dirs.mjs";

const MAX_FILE_BYTES = 512 * 1024;

// Workload kinds that run a long-lived server. Job and CronJob are deliberately excluded from the
// probe check: a batch task that exits is supposed to have no readiness probe, and flagging it
// would be the kind of false positive that gets a gate switched off.
const SERVER_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Pod"]);
const WORKLOAD_KINDS = new Set([...SERVER_KINDS, "Job", "CronJob"]);

// Fields that belong to a container, never to a PodSpec. A PodSpec carrying `resources` is not a
// pod with resource limits -- it is a manifest the API server rejects, because PodSpec has no such
// field. Observed in webhook-5, where the Deployment could not have been applied at all.
const CONTAINER_ONLY_FIELDS = new Set([
  "image", "resources", "ports", "env", "envFrom", "volumeMounts", "command", "args",
  "livenessProbe", "readinessProbe", "startupProbe", "imagePullPolicy", "securityContext:container",
]);

// Kubernetes expands `$(VAR)` inside container env and command, and nothing else. A `${...}` is
// shell or Terraform interpolation that reaches the cluster as a literal -- webhook-5 shipped
// `arn:aws:iam::${var.account_id}:role/...` as an IRSA annotation on both the ServiceAccount and
// the pod template, so the role binding could never have resolved.
const UNEXPANDED_INTERPOLATION = /\$\{[^}]+\}/;

const HEALTH_ROUTE =
  /["'`](\/(?:health\w*|healthz|readyz|livez|ready|ping|status))["'`]/i;

function walkFiles(dir, exts, acc = [], root = dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkFiles(full, exts, acc, root);
      continue;
    }
    const ext = path.extname(e.name);
    if (!exts.includes(ext)) continue;
    try {
      if (statSync(full).size <= MAX_FILE_BYTES) {
        acc.push({ rel: path.relative(root, full), ext, text: readFileSync(full, "utf8") });
      }
    } catch {
      /* unreadable is not this check's problem to report */
    }
  }
  return acc;
}

function podSpecOf(doc) {
  if (doc?.kind === "Pod") return doc.spec || null;
  if (doc?.kind === "CronJob") return doc.spec?.jobTemplate?.spec?.template?.spec || null;
  return doc?.spec?.template?.spec || null;
}

/** Every Kubernetes document in the project, with the file it came from. */
export function manifestDocs(projectDir) {
  const out = [];
  for (const f of walkFiles(projectDir, [".yaml", ".yml"])) {
    let docs;
    try {
      docs = parseAllDocuments(f.text);
    } catch {
      continue;
    }
    for (const d of docs) {
      let obj;
      try {
        obj = d.toJS?.({ maxAliasCount: -1 });
      } catch {
        continue;
      }
      if (obj && typeof obj === "object" && obj.kind && obj.apiVersion) out.push({ file: f.rel, doc: obj });
    }
  }
  return out;
}

/** Does the application expose an HTTP health endpoint? Evidence that a probe has a target. */
export function healthRoutes(projectDir) {
  const found = [];
  for (const f of walkFiles(projectDir, [".py", ".js", ".mjs", ".ts", ".tsx", ".go", ".rb"])) {
    const m = HEALTH_ROUTE.exec(f.text);
    if (m) found.push({ file: f.rel, path: m[1] });
  }
  return found;
}

export function checkK8sManifests(projectDir) {
  const docs = manifestDocs(projectDir);
  if (docs.length === 0) {
    return { ran: false, unknown: "no Kubernetes manifests found", misplaced: [], unexpanded: [], unprobed: [] };
  }

  const misplaced = [];
  const unexpanded = [];
  const unprobed = [];
  const health = healthRoutes(projectDir);

  for (const { file, doc } of docs) {
    // -- unexpanded interpolation, anywhere in the document --------------------------------------
    const scan = (node, trail) => {
      if (typeof node === "string") {
        if (UNEXPANDED_INTERPOLATION.test(node)) {
          unexpanded.push({ file, kind: doc.kind, at: trail, value: node });
        }
        return;
      }
      if (Array.isArray(node)) return node.forEach((v, i) => scan(v, `${trail}[${i}]`));
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) scan(v, trail ? `${trail}.${k}` : k);
      }
    };
    scan(doc, "");

    if (!WORKLOAD_KINDS.has(doc.kind)) continue;
    const spec = podSpecOf(doc);
    if (!spec || typeof spec !== "object") continue;

    // -- container fields sitting on the PodSpec --------------------------------------------------
    for (const field of Object.keys(spec)) {
      if (CONTAINER_ONLY_FIELDS.has(field)) {
        misplaced.push({ file, kind: doc.kind, name: doc.metadata?.name ?? "(unnamed)", field });
      }
    }

    // -- a server with a health endpoint and no probe wired to it ---------------------------------
    if (SERVER_KINDS.has(doc.kind) && health.length > 0) {
      for (const c of spec.containers || []) {
        const probes = ["livenessProbe", "readinessProbe", "startupProbe"].filter((p) => c[p]);
        if (probes.length === 0) {
          unprobed.push({ file, kind: doc.kind, name: doc.metadata?.name ?? "(unnamed)", container: c.name, health: health[0].path });
        }
      }
    }
  }

  return { ran: true, unknown: null, misplaced, unexpanded, unprobed };
}

/** Blocking failures for the gate. */
export function k8sManifestFailures(projectDir) {
  const r = checkK8sManifests(projectDir);
  if (!r.ran) return { failures: [], advisories: [`kubernetes manifests: not checked — ${r.unknown}`] };

  const failures = [];

  if (r.misplaced.length > 0) {
    const list = r.misplaced.map((m) => `${m.file}: ${m.kind}/${m.name} has "${m.field}" on the pod spec`).join("; ");
    failures.push(
      `kubernetes manifests: ${r.misplaced.length} container field(s) are attached to the pod spec ` +
        `instead of to a container — ${list}.\n` +
        `A PodSpec has no such field, so the API server rejects the whole object: this manifest does ` +
        `not deploy at all, it is not merely missing the setting. The YAML is valid, which is why ` +
        `nothing else here reports it. Move the field inside the relevant entry of spec.containers[].`
    );
  }

  if (r.unexpanded.length > 0) {
    const list = r.unexpanded.map((u) => `${u.file}: ${u.at} = ${u.value}`).join("; ");
    failures.push(
      `kubernetes manifests: ${r.unexpanded.length} value(s) contain \${...} interpolation that ` +
        `Kubernetes never expands — ${list}.\n` +
        `Kubernetes substitutes $(VAR) inside container env and command, and nothing else. A \${...} ` +
        `is Terraform or shell syntax that reaches the cluster as a literal string, so anything ` +
        `depending on it — an IAM role ARN in an IRSA annotation, most damagingly — silently never ` +
        `resolves. Emit the manifest from Terraform, or substitute the value before applying.`
    );
  }

  if (r.unprobed.length > 0) {
    const list = r.unprobed.map((u) => `${u.kind}/${u.name} container "${u.container}" (${u.file})`).join("; ");
    failures.push(
      `kubernetes manifests: the application serves ${r.unprobed[0].health} but ${r.unprobed.length} ` +
        `container(s) declare no liveness, readiness or startup probe — ${list}.\n` +
        `An unwired health endpoint is worse than none: the load balancer has nothing to ask, so it ` +
        `keeps routing to a pod that cannot serve. Observed exactly that way — a receiver answered ` +
        `/health with 200 while every real request failed, because the health path tested nothing ` +
        `the requests depended on. Add a readinessProbe httpGet on that path, and make it check the ` +
        `dependencies a request actually needs.`
    );
  }

  return { failures, advisories: [] };
}
