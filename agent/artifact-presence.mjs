// An artifact that exists but holds nothing, and a deliverable the task named that was never
// produced. Both pass every check that inspects content, because there is no content to inspect.
//
// From a real run: told to fix findings in its Kubernetes manifests, a model wrote all five of them
// back as empty files. Its blocking failures dropped from five to two, and three checks —
// manifest_contract, k8s_manifest and iam_contract — went quiet. They had not passed; they had
// nothing left to read. The task requires "Kubernetes manifests for the service", and a project
// with five zero-byte YAML files satisfied every manifest-aware gate in the loop.
//
// This is the purest form of the failure this project keeps finding: silence reading as success.
// Unlike the Terraform resource census, which is advisory because a rename cannot be told from a
// deletion, an emptied file is unambiguous — the path is still declared, and nothing is in it.

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

import { taskMatcher } from "./task-phrases.mjs";
import { SKIP_DIRS } from "./skip-dirs.mjs";

// Extensions where an empty file is never deliberate work. Deliberately excludes .gitignore,
// __init__.py and similar, which are legitimately empty.
const MEANINGFUL_EXT = new Set([".yaml", ".yml", ".tf", ".tfvars", ".py", ".js", ".mjs", ".ts", ".tsx", ".go", ".rb", ".sql", ".json"]);
const LEGITIMATELY_EMPTY = /(^|\/)(__init__\.py|\.gitkeep|\.gitignore|py\.typed)$/;

// What the task asked to be produced. Keyed on the deployment vocabulary the benchmark tasks use,
// and each requires evidence in the project rather than a filename convention.
// This gate BLOCKS, so the vocabulary widens only to terms that genuinely imply the artifact. A
// trigger that fires wrongly makes a correct project fail for not producing something it was never
// asked for, and that is the direction that gets a gate switched off.
//
// Two deliberate exclusions, both tempting and both wrong here:
//
//  * A bare "cluster" does not imply Kubernetes. "Run it on our existing cluster" is equally an
//    ECS cluster, a Nomad cluster, a Spark cluster or a database cluster, and demanding Kubernetes
//    manifests for any of them is a false block. A task that means Kubernetes says EKS, Helm,
//    kubectl or Kubernetes, and every acceptance case that mentions a cluster also names IaC.
//  * A bare "deploy" or "cloud" implies none of the three. Almost every task in this family
//    contains one of them.
//
// The old kubernetes pattern also used `\bmanifests?\b.*\bservice\b`, where `.*` crosses
// sentences: a task naming manifests in one paragraph and a service in another matched. Proximity
// is clause-bounded now.
const ARTIFACT_REQUIREMENTS = [
  {
    id: "kubernetes",
    taskPhrase: taskMatcher({
      any: [/\bkubernetes\b/i, /\bk8s\b/i, /\bEKS\b/, /\bGKE\b/, /\bAKS\b/, /\bkubectl\b/i,
            /\bkustomize\b/i, /\bhelm\s+charts?\b/i, /\bpod\s+specs?\b/i],
      near: [{ terms: "manifests?", nouns: "kubernetes|k8s|helm|pods?|ingress|namespaces?|cluster" }],
    }),
    label: "Kubernetes manifests",
    satisfied: (files) =>
      files.some((f) => [".yaml", ".yml"].includes(f.ext) && /\bkind\s*:/.test(f.text)),
  },
  {
    id: "dockerfile",
    taskPhrase: taskMatcher({
      any: [/\bdockerfiles?\b/i, /\bcontainer\s+images?\b/i, /\bOCI\s+images?\b/i,
            /\bcontaineri[sz]\w*\b/i, /\bdocker\s+build\b/i],
      // "ship it as a container", "package the service in a container". Spelled out rather than
      // stemmed: `ship\w*` would take "shipping" in "shipping address".
      near: [{ terms: "ships?|shipped|packages?|packaged|runs?|builds?|built", nouns: "containers?" }],
    }),
    label: "a Dockerfile",
    satisfied: (files) => files.some((f) => /dockerfile/i.test(path.basename(f.rel)) && /\bFROM\s+\S/i.test(f.text)),
  },
  {
    id: "terraform",
    taskPhrase: taskMatcher({
      any: [/\bterraform\b/i, /\bopentofu\b/i, /\bHCL\b/,
            /\binfrastructure[-\s]as[-\s]code\b/i, /\bIaC\b/],
      near: [{ terms: "declares?|declared|defines?|defined|provisions?|provisioned|describes?|described",
               nouns: "cloud resources?|infrastructure|aws resources?" }],
    }),
    label: "Terraform configuration",
    satisfied: (files) => files.some((f) => f.ext === ".tf" && /\b(resource|module|data)\s+"/.test(f.text)),
  },
];

function walkAll(dir, acc = [], root = dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkAll(full, acc, root);
      continue;
    }
    try {
      const st = statSync(full);
      if (st.size > 2 * 1024 * 1024) continue;
      acc.push({
        rel: path.relative(root, full),
        ext: path.extname(e.name),
        size: st.size,
        text: st.size === 0 ? "" : readFileSync(full, "utf8"),
      });
    } catch {
      /* unreadable is not this check's problem to report */
    }
  }
  return acc;
}

export function checkArtifactPresence(projectDir, taskText = "") {
  const files = walkAll(projectDir);
  if (files.length === 0) return { ran: false, unknown: "no files in the project", empty: [], missing: [] };

  const empty = files.filter(
    (f) =>
      (MEANINGFUL_EXT.has(f.ext) || /dockerfile/i.test(path.basename(f.rel))) &&
      !LEGITIMATELY_EMPTY.test(f.rel) &&
      f.text.trim() === ""
  );

  const missing = ARTIFACT_REQUIREMENTS.filter(
    (r) => r.taskPhrase(taskText) && !r.satisfied(files)
  );

  return { ran: true, unknown: null, empty, missing };
}

/** Blocking failures for the gate. */
export function artifactPresenceFailures(projectDir, taskText = "") {
  const r = checkArtifactPresence(projectDir, taskText);
  if (!r.ran) return { failures: [], advisories: [`artifact presence: not checked — ${r.unknown}`] };

  const failures = [];

  if (r.empty.length > 0) {
    const list = r.empty.map((f) => f.rel).join(", ");
    failures.push(
      `artifact presence: ${r.empty.length} file(s) exist but are empty — ${list}.\n` +
        `An empty file is not a smaller version of the work; it is the absence of the work wearing ` +
        `its filename. Every check that reads these passes, because there is nothing to read — ` +
        `which is why this is reported here rather than by any of them. If a file's content was ` +
        `removed while fixing something else, restore it. If it was never needed, remove it with ` +
        `delete_file — do not leave an empty one behind. (That advice previously said "delete the ` +
        `file" when the tool set had no way to do so, which is why two runs overwrote files with ` +
        `empty or placeholder content instead: it was the only move available to them.)`
    );
  }

  if (r.missing.length > 0) {
    const list = r.missing.map((m) => m.label).join(", ");
    failures.push(
      `artifact presence: the task asks for ${list}, and the project contains none.\n` +
        `Checked by content rather than by filename: a .yaml with no \`kind:\`, a Dockerfile with no ` +
        `FROM, or a .tf with no resource/module/data block does not count as the artifact. The ` +
        `deployment section of the task lists these explicitly, so a deliverable without them is ` +
        `incomplete no matter how correct the application code is.`
    );
  }

  return { failures, advisories: [] };
}

/**
 * The set of artifacts that currently hold content, for comparison across validation rounds.
 *
 * The Terraform resource census is advisory because it compares resource ADDRESSES, and a rename
 * cannot be told from a deletion. This one compares files the run itself produced within a single
 * run, so a path that held content last round and holds none now is unambiguous — nothing was
 * renamed, the work was removed. It also covers every artifact type rather than Terraform alone,
 * which is why five Kubernetes manifests could be emptied without the census noticing.
 */
export function artifactInventory(projectDir) {
  const inv = new Map();
  for (const f of walkAll(projectDir)) {
    if (!MEANINGFUL_EXT.has(f.ext) && !/dockerfile/i.test(path.basename(f.rel))) continue;
    if (f.text.trim() !== "") inv.set(f.rel, f.text.trim().length);
  }
  return inv;
}

/** Artifacts that held content in `before` and hold none now. */
export function artifactRegressions(before, after) {
  if (!before) return [];
  const gone = [];
  for (const [rel, size] of before) {
    if (!after.has(rel)) gone.push({ rel, was: size, now: "gone" });
    else if (after.get(rel) < size * 0.2) gone.push({ rel, was: size, now: after.get(rel) });
  }
  return gone;
}
