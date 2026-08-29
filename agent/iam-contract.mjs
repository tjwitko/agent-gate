// Two IAM defects that a clean `terraform plan` cannot see, both graded on webhook-6.
//
// Terraform does not resolve AWS managed-policy ARNs at plan time and does not know what a
// ServiceAccount annotation means, so both of these produce a plan the gate approves and an
// infrastructure that does not work. Neither is a security hole exactly; both are total failures.

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { parseAllDocuments } from "yaml";
import { SKIP_DIRS } from "./skip-dirs.mjs";

const MAX_FILE_BYTES = 512 * 1024;

// AWS managed policies seen in this project's problem space. NOT the complete set -- AWS publishes
// well over a thousand -- which is exactly why an unknown name is reported as unverifiable rather
// than as wrong. Note AmazonEKS_CNI_Policy: real policy names DO contain underscores, so "looks
// oddly punctuated" is not evidence of anything.
const KNOWN_MANAGED_POLICIES = new Set([
  "AdministratorAccess", "AmazonDynamoDBFullAccess", "AmazonDynamoDBReadOnlyAccess",
  "AmazonEBSCSIDriverPolicy", "AmazonEC2ContainerRegistryFullAccess",
  "AmazonEC2ContainerRegistryPowerUser", "AmazonEC2ContainerRegistryReadOnly",
  "AmazonEC2ReadOnlyAccess", "AmazonEC2FullAccess", "AmazonEFSCSIDriverPolicy",
  "AmazonEKSClusterPolicy", "AmazonEKSServicePolicy", "AmazonEKSVPCResourceController",
  "AmazonEKSWorkerNodePolicy", "AmazonEKSWorkerNodeMinimalPolicy", "AmazonEKS_CNI_Policy",
  "AmazonElasticFileSystemFullAccess", "AmazonKinesisFullAccess", "AmazonRDSFullAccess",
  "AmazonS3FullAccess", "AmazonS3ReadOnlyAccess", "AmazonSNSFullAccess", "AmazonSQSFullAccess",
  "AmazonSSMManagedInstanceCore", "AmazonSSMReadOnlyAccess", "AmazonVPCFullAccess",
  "AWSLambdaBasicExecutionRole", "AWSLambdaVPCAccessExecutionRole", "AWSXrayWriteOnlyAccess",
  "CloudWatchAgentServerPolicy", "CloudWatchFullAccess", "CloudWatchLogsFullAccess",
  "CloudWatchLogsReadOnlyAccess", "ReadOnlyAccess", "SecretsManagerReadWrite",
  "AmazonSecretsManagerReadWrite", "PowerUserAccess",
]);

const MANAGED_POLICY_ARN = /arn:aws[a-z-]*:iam::aws:policy\/(?:[\w+=,.@-]+\/)*([\w+=,.@-]+)/g;

// An unknown name that is a prefix-match for a real one is a near miss -- almost certainly the
// real policy misremembered, e.g. AmazonEBSCSID_Policy for AmazonEBSCSIDriverPolicy. Distinguished
// from a merely unrecognised name because only the former can be reported with confidence offline.
function normalise(name) {
  return name.toLowerCase().replace(/[_-]/g, "");
}
function nearestKnown(name) {
  const n = normalise(name);
  const stem = n.replace(/policy$/, "");
  if (stem.length < 10) return null;
  for (const known of KNOWN_MANAGED_POLICIES) {
    const k = normalise(known);
    if (k !== n && (k.startsWith(stem) || n.startsWith(k.replace(/policy$/, "")))) return known;
  }
  return null;
}

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
    if (!exts.includes(path.extname(e.name))) continue;
    try {
      if (statSync(full).size <= MAX_FILE_BYTES) {
        acc.push({ rel: path.relative(root, full), text: readFileSync(full, "utf8") });
      }
    } catch {
      /* unreadable is not this check's problem to report */
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------------------------
// 1. Managed-policy ARNs that do not exist
// ---------------------------------------------------------------------------------------------

export function checkManagedPolicies(projectDir) {
  const files = walkFiles(projectDir, [".tf"]);
  const wrong = [];
  const unverifiable = [];
  let seen = 0;

  for (const f of files) {
    MANAGED_POLICY_ARN.lastIndex = 0;
    let m;
    while ((m = MANAGED_POLICY_ARN.exec(f.text))) {
      const name = m[1];
      seen++;
      if (KNOWN_MANAGED_POLICIES.has(name)) continue;
      const near = nearestKnown(name);
      if (near) wrong.push({ file: f.rel, name, near });
      else unverifiable.push({ file: f.rel, name });
    }
  }
  return { ran: files.length > 0, seen, wrong, unverifiable };
}

// ---------------------------------------------------------------------------------------------
// 2. An IRSA role that no ServiceAccount can assume
// ---------------------------------------------------------------------------------------------

const IRSA_ANNOTATION = "eks.amazonaws.com/role-arn";
// The account field is exactly 12 digits. Requiring that is what separates a usable ARN from
// `arn:aws:iam::ACCOUNT_ID:role/...`, a placeholder two deliverables shipped and which the
// admission controller cannot resolve any more than it could an empty string.
const WELL_FORMED_ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/.+$/;
// Lenient: gets the role name out even when the account field is a placeholder, so a bad ARN does
// not also cost us the trust-policy verdict on the role it names.
const ROLE_NAME_FROM_ARN = /:role\/(.+)$/;

/** Role names that a Kubernetes ServiceAccount claims through an IRSA annotation. */
export function irsaAnnotatedRoles(projectDir) {
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
      const collect = (ann, where) => {
        const arn = ann?.[IRSA_ANNOTATION];
        if (typeof arn !== "string") return;
        const value = arn.trim();
        // Two independent judgements, deliberately not one. The role NAME is usable even when the
        // account field is a placeholder, so the trust-policy check must still run against it --
        // folding them together once traded a real trust-policy finding for a placeholder one and
        // reported strictly less than before.
        const name = ROLE_NAME_FROM_ARN.exec(value);
        out.push({
          file: f.rel,
          where,
          role: name ? name[1].split("/").pop() : null,
          arn: value,
          malformed: !WELL_FORMED_ROLE_ARN.test(value),
        });
      };
      if (obj?.kind === "ServiceAccount") collect(obj.metadata?.annotations, `ServiceAccount/${obj.metadata?.name}`);
      collect(obj?.spec?.template?.metadata?.annotations, `${obj?.kind}/${obj?.metadata?.name} pod template`);
    }
  }
  return out;
}

/** aws_iam_role blocks, with the text of each so its trust policy can be read. */
function terraformRoles(projectDir) {
  const roles = [];
  for (const f of walkFiles(projectDir, [".tf"])) {
    const re = /resource\s+"aws_iam_role"\s+"([\w-]+)"\s*\{/g;
    let m;
    while ((m = re.exec(f.text))) {
      // Brace-matched rather than a fixed window, so a long role body cannot spill into the next
      // resource and lend it a trust policy it does not have.
      let depth = 0;
      let end = m.index;
      for (let i = f.text.indexOf("{", m.index); i < f.text.length; i++) {
        if (f.text[i] === "{") depth++;
        else if (f.text[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      const body = f.text.slice(m.index, end);
      const nameMatch = /\bname\s*=\s*"([^"]+)"/.exec(body);
      roles.push({ file: f.rel, label: m[1], name: nameMatch ? nameMatch[1] : null, body });
    }
  }
  return roles;
}

const WEB_IDENTITY = /sts:AssumeRoleWithWebIdentity/;
const FEDERATED_PRINCIPAL = /\bFederated\b/;
const SERVICE_PRINCIPAL = /\bService\s*=\s*"([^"]+)"|"Service"\s*:\s*"([^"]+)"/;

export function checkIrsa(projectDir) {
  const annotated = irsaAnnotatedRoles(projectDir);
  if (annotated.length === 0) return { ran: false, unknown: "no ServiceAccount declares an IRSA role annotation", broken: [], unmatched: [] };

  const roles = terraformRoles(projectDir);
  const hasOidcProvider = walkFiles(projectDir, [".tf"]).some((f) =>
    /resource\s+"aws_iam_openid_connect_provider"/.test(f.text)
  );

  const broken = [];
  const unmatched = [];

  // A ${...} value is already reported by the k8s manifest check, which owns unexpanded
  // interpolation wherever it appears. Reporting it here too would give one defect two names and
  // two different remediations.
  const malformed = annotated.filter((a) => a.malformed && !/\$\{/.test(a.arn || ""));
  for (const a of annotated.filter((x) => x.role)) {
    const role = roles.find((r) => r.name === a.role || r.label === a.role);
    if (!role) {
      unmatched.push(a);
      continue;
    }
    const federated = FEDERATED_PRINCIPAL.test(role.body);
    const webIdentity = WEB_IDENTITY.test(role.body);
    if (webIdentity && federated) continue;

    // Say which half is wrong. Both halves are required and they fail for different reasons: a
    // Service principal is an instance-profile trust a pod can never use, while a Federated
    // principal paired with plain sts:AssumeRole names the right party for the wrong call --
    // graded on a real deliverable, where reporting it as "no recognisable principal" would have
    // sent someone looking for a missing principal that was already there.
    const svc = SERVICE_PRINCIPAL.exec(role.body);
    const reason = federated
      ? "names a Federated principal but allows sts:AssumeRole rather than sts:AssumeRoleWithWebIdentity"
      : svc
        ? `trusts the service principal ${svc[1] || svc[2]}, which is an EC2 instance-profile trust`
        : "names neither a Federated principal nor sts:AssumeRoleWithWebIdentity";
    broken.push({ ...a, roleFile: role.file, reason, hasOidcProvider });
  }
  return { ran: true, unknown: null, broken, unmatched, malformed, hasOidcProvider };
}

// ---------------------------------------------------------------------------------------------

export function iamContractFailures(projectDir) {
  const failures = [];
  const advisories = [];

  const mp = checkManagedPolicies(projectDir);
  if (mp.wrong.length > 0) {
    const list = mp.wrong.map((w) => `${w.file}: ${w.name} (did you mean ${w.near}?)`).join("; ");
    failures.push(
      `iam: ${mp.wrong.length} attached AWS managed policy ARN(s) do not exist — ${list}.\n` +
        `Terraform does not resolve managed-policy ARNs at plan time, so a scan of the plan cannot ` +
        `see this: the plan is clean and \`terraform apply\` then fails with NoSuchEntity, after ` +
        `some resources have already been created. Each of these closely matches a real policy name, ` +
        `which is why it is reported as wrong rather than merely unrecognised.`
    );
  }
  if (mp.unverifiable.length > 0) {
    const list = mp.unverifiable.map((u) => `${u.file}: ${u.name}`).join("; ");
    advisories.push(
      `iam: ${mp.unverifiable.length} attached AWS managed policy ARN(s) are not in this check's ` +
        `known list — ${list}. AWS publishes well over a thousand managed policies and this check ` +
        `carries only the common ones, so an unrecognised name is NOT evidence of a wrong one. ` +
        `Confirm each exists (\`aws iam get-policy --policy-arn ...\`): a name that does not exist ` +
        `plans clean and fails at apply.`
    );
  }

  const irsa = checkIrsa(projectDir);
  if (irsa.ran && irsa.broken.length > 0) {
    const list = irsa.broken
      .map((b) => `${b.where} (${b.file}) -> role "${b.role}" in ${b.roleFile}, which ${b.reason}`)
      .join("; ");
    const oidcNote = irsa.hasOidcProvider
      ? ""
      : ` There is also no aws_iam_openid_connect_provider resource anywhere in the configuration, so ` +
        `the cluster has no OIDC provider for such a trust policy to name.`;
    failures.push(
      `iam: ${irsa.broken.length} role(s) annotated onto a ServiceAccount cannot be assumed by it — ${list}.\n` +
        `IRSA works by the pod exchanging a projected service-account token via ` +
        `sts:AssumeRoleWithWebIdentity, so the role's trust policy must name the cluster's OIDC ` +
        `provider as a Federated principal. A Service principal is the trust an EC2 instance profile ` +
        `uses and cannot be assumed by a pod. Both artifacts look right on their own -- the ` +
        `annotation names a real role, the role exists -- and the defect is only in the gap, so ` +
        `nothing else here reports it. The pod gets no credentials and every AWS call fails.${oidcNote}`
    );
  }
  if (irsa.ran && irsa.malformed.length > 0) {
    const list = irsa.malformed.map((m) => `${m.where} (${m.file}) = ${m.arn || "(empty)"}`).join("; ");
    failures.push(
      `iam: ${irsa.malformed.length} IRSA annotation(s) are not a role ARN — ${list}.\n` +
        `eks.amazonaws.com/role-arn must carry a complete arn:aws:iam::<account>:role/<name>. A ` +
        `placeholder left in place is applied exactly as written: the webhook admission controller ` +
        `finds no usable ARN, injects no credentials, and every AWS call from the pod fails with no ` +
        `indication that the annotation was the cause. Substitute the real ARN before applying, or ` +
        `emit the manifest from Terraform so the value comes from the role resource itself.`
    );
  }

  if (irsa.ran && irsa.unmatched.length > 0) {
    advisories.push(
      `iam: ${irsa.unmatched.length} IRSA annotation(s) name a role this project does not define — ` +
        `${irsa.unmatched.map((u) => `${u.where} -> ${u.role}`).join("; ")}. If the role is managed ` +
        `elsewhere this is fine; if it was meant to be here, the annotation points at nothing.`
    );
  }

  return { failures, advisories };
}
