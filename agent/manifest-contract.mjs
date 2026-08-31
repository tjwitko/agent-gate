// Does the deployment actually supply what the application requires?
//
// Built after a webhook receiver authenticated both of its routes, passed the authentication gate,
// and still served every stored callback to an unauthenticated request. Its Deployment set
// S3_BUCKET, DYNAMODB_TABLE, AWS_REGION and SIGNING_SECRETS -- and not SUPPORT_API_KEY or
// PROVIDER_API_KEY, which the code compares against caller input. Applying those manifests as
// written produces an open endpoint.
//
// Nothing in the stack looked at both sides. Each artifact was correct on its own terms: the code
// reads a variable, the manifest sets some variables, and neither is wrong in isolation. The defect
// only exists in the gap between them, which is where a whole class of deployment failures lives.
//
// Two rules carried over from the other gates:
//   1. An undetermined answer is an advisory, never a pass. `envFrom` pulls a whole ConfigMap or
//      Secret whose keys are not in the manifest, so the contract cannot be checked -- and this
//      says so rather than reporting a clean result it has not earned.
//   2. It reports names, not counts, because the fix is per variable.

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { parseAllDocuments } from "yaml";

import { SKIP_DIRS } from "./skip-dirs.mjs";

const MAX_FILE_BYTES = 512 * 1024;

// Read with no fallback: the code expects the environment to provide it. `os.getenv("X", "default")`
// is excluded because a default means the variable is optional by construction.
const PY_ENV_REQUIRED = [
  // Not followed by `=`, or a test that SETS a variable is counted as the application requiring it.
  // Tests only began appearing once the task asked for them, and the first suite to do so wrote
  // `os.environ["WEBHOOK_SECRET"] = ...`, which this reported as two environment variables the
  // manifests failed to supply. `==` is still a read, so the exclusion is a single `=` only.
  // The whitespace belongs INSIDE the lookahead: written as `\s*(?!=[^=])` the star backtracks to
  // zero, the assertion then looks at a space rather than the `=`, and every assignment matches
  // anyway. `==` is still a read, so only a single `=` is excluded.
  /\bos\.environ\s*\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\](?!\s*=[^=])/g,
  /\bos\.getenv\s*\(\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\)/g,
  /\bos\.environ\.get\s*\(\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\)/g,
];

const JS_ENV_REQUIRED = [/\bprocess\.env\.([A-Z_][A-Z0-9_]*)\b/g, /\bprocess\.env\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\]/g];

// Supplied by the platform rather than by the manifest author. IRSA injects the role and token
// path into the pod; the region and Kubernetes service variables come from the environment itself.
// Reporting these as missing would be noise, and noise is how a blocking check gets switched off.
const PLATFORM_PROVIDED = new Set([
  "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_STS_REGIONAL_ENDPOINTS", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT", "HOSTNAME", "PATH", "HOME", "PORT", "TZ",
  "PYTHONPATH", "PYTHONUNBUFFERED", "NODE_ENV",
]);

function walk(dir, acc = [], root = dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, acc, root);
      continue;
    }
    const ext = path.extname(e.name);
    if (![".py", ".js", ".mjs", ".ts", ".yaml", ".yml", ".tf"].includes(ext)) continue;
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

/** Environment variables the application reads with no fallback. */
export function requiredEnv(files) {
  const found = new Map();
  for (const f of files) {
    const patterns = f.ext === ".py" ? PY_ENV_REQUIRED : [".js", ".mjs", ".ts"].includes(f.ext) ? JS_ENV_REQUIRED : null;
    if (!patterns) continue;
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(f.text))) {
        if (PLATFORM_PROVIDED.has(m[1])) continue;
        if (!found.has(m[1])) found.set(m[1], f.rel);
      }
    }
  }
  return found;
}

// A workload declared through Terraform's kubernetes provider rather than a YAML manifest. Real
// runs use both, sometimes in the same project, and treating the Terraform form as "no workload
// found" reports an honest unknown where the answer is actually available.
//
//   env {
//     name  = "DATABASE_URL"
//     value = "..."
//   }
const TF_KUBERNETES_WORKLOAD = /resource\s+"kubernetes_(deployment|pod|stateful_set|daemon_set|job|cron_job)(_v1)?"/;
const TF_ENV_BLOCK = /\benv\s*\{[^}]*?\bname\s*=\s*"([A-Z_][A-Z0-9_]*)"/g;
// env_from pulls a whole ConfigMap or Secret, exactly like envFrom in YAML.
const TF_ENV_FROM = /\benv_from\s*\{/;

/**
 * Environment variables the Kubernetes manifests supply, and whether anything makes the set
 * unknowable. Walks the parsed document rather than matching text: `- name:` appears on containers,
 * volumes and ports too, and counting those as environment variables would hide a real gap.
 */
export function providedEnv(files) {
  const provided = new Set();
  let opaque = null;
  let sawWorkload = false;

  // Every one of these shapes is assumed rather than guaranteed. A Helm chart parses as YAML but
  // not as Kubernetes: `env:` followed by `{{- range .Values.environment }}` yields something that
  // is not a list, and iterating it threw — which took the WHOLE validation phase down, because a
  // check that throws was not isolated from the others. Nothing here may assume a shape.
  const visitContainers = (containers) => {
    if (!Array.isArray(containers)) return;
    for (const c of containers) {
      if (!c || typeof c !== "object") continue;
      sawWorkload = true;
      if (Array.isArray(c.env)) for (const e of c.env) if (e && e.name) provided.add(e.name);
      if (Array.isArray(c.envFrom) && c.envFrom.length > 0) {
        const src = c.envFrom
          .map((r) => (r.configMapRef ? `ConfigMap/${r.configMapRef.name}` : r.secretRef ? `Secret/${r.secretRef.name}` : "a source"))
          .join(", ");
        opaque = src;
      }
    }
  };

  for (const f of files) {
    if (f.ext === ".tf") {
      if (!TF_KUBERNETES_WORKLOAD.test(f.text)) continue;
      sawWorkload = true;
      if (TF_ENV_FROM.test(f.text)) opaque = "a Terraform env_from block";
      TF_ENV_BLOCK.lastIndex = 0;
      let m;
      while ((m = TF_ENV_BLOCK.exec(f.text))) provided.add(m[1]);
      continue;
    }
    if (![".yaml", ".yml"].includes(f.ext)) continue;
    let docs;
    try {
      docs = parseAllDocuments(f.text).map((d) => d.toJS({ maxAliasCount: 100 }));
    } catch {
      continue; // not parseable as YAML — not this check's problem to report
    }
    for (const doc of docs) {
      if (!doc || typeof doc !== "object") continue;
      const spec = doc.spec?.template?.spec || doc.spec?.jobTemplate?.spec?.template?.spec || (doc.kind === "Pod" ? doc.spec : null);
      if (!spec) continue;
      visitContainers(spec.containers);
      visitContainers(spec.initContainers);
    }
  }
  return { provided, opaque, sawWorkload };
}

/** Variables the code requires that no manifest supplies. */
export function checkManifestContract(projectDir) {
  const files = walk(projectDir);
  const required = requiredEnv(files);
  const { provided, opaque, sawWorkload } = providedEnv(files);

  if (required.size === 0) return { ran: true, missing: [], unknown: null };
  if (!sawWorkload) {
    return {
      ran: true,
      missing: [],
      unknown: `the code requires ${required.size} environment variable(s) and no Kubernetes workload was found to supply them`,
    };
  }
  if (opaque) {
    return {
      ran: true,
      missing: [],
      unknown: `envFrom pulls ${opaque}, whose keys are not in the manifests, so the contract cannot be checked here`,
    };
  }

  const missing = [...required.entries()].filter(([name]) => !provided.has(name)).map(([name, file]) => ({ name, file }));
  return { ran: true, missing, unknown: null };
}

/** Blocking failures for the gate. */
export function manifestContractFailures(projectDir) {
  const report = checkManifestContract(projectDir);
  if (report.unknown) return { failures: [], advisories: [`manifest contract: ${report.unknown}`] };
  if (report.missing.length === 0) return { failures: [], advisories: [] };

  const list = report.missing.map((m) => `${m.name} (read in ${m.file})`).join(", ");
  return {
    failures: [
      `manifest contract: the application requires ${report.missing.length} environment ` +
        `variable(s) that no Kubernetes manifest supplies — ${list}.\n` +
        `Each artifact is correct on its own terms, so nothing else here reports this: the code ` +
        `reads a variable, the manifests set some variables, and the defect exists only in the gap. ` +
        `Applying these manifests produces a container where each of these is unset — and a ` +
        `credential compared against an unset value does not fail closed. Add them to the ` +
        `Deployment, sourcing anything secret from a Secret rather than an inline value.`,
    ],
    advisories: [],
  };
}
