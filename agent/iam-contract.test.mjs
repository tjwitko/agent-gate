import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { iamContractFailures, checkIrsa, checkManagedPolicies } from "./iam-contract.mjs";

function run(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "iam-"));
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

const sa = (arn) =>
  "apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: app-sa\n  annotations:\n" +
  `    eks.amazonaws.com/role-arn: ${arn}\n`;

const role = (trust) =>
  'resource "aws_iam_role" "pod" {\n  name = "app-role"\n\n  assume_role_policy = jsonencode({\n' +
  "    Statement = [\n      {\n" + trust + "\n      }\n    ]\n  })\n}\n";

const IRSA_TRUST =
  '        Action = "sts:AssumeRoleWithWebIdentity"\n        Effect = "Allow"\n' +
  '        Principal = { Federated = "arn:aws:iam::123456789012:oidc-provider/oidc.eks.example" }';
const EC2_TRUST =
  '        Action = "sts:AssumeRole"\n        Effect = "Allow"\n' +
  '        Principal = { Service = "ec2.amazonaws.com" }';
const FEDERATED_WRONG_ACTION =
  '        Action = "sts:AssumeRole"\n        Effect = "Allow"\n' +
  '        Principal = { Federated = "arn:aws:iam::123456789012:oidc-provider/oidc.eks.example" }';

const GOOD_ARN = "arn:aws:iam::123456789012:role/app-role";

// --- managed policy ARNs -------------------------------------------------------------------------

test("a near-miss managed policy name is reported as wrong", () => {
  const { failures } = run(
    { "terraform/main.tf": 'resource "aws_iam_role_policy_attachment" "a" {\n  policy_arn = "arn:aws:iam::aws:policy/AmazonEBSCSID_Policy"\n}\n' },
    iamContractFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /do not exist/);
  assert.match(failures[0], /did you mean AmazonEBSCSIDriverPolicy/);
});

test("a real managed policy is clean, underscores and all", () => {
  const { failures, advisories } = run(
    { "terraform/main.tf": 'policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"\n' },
    iamContractFailures
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(advisories, []);
});

// The list cannot be complete, so an unrecognised name must not be called wrong.
test("an unrecognised name is advisory, not a failure", () => {
  const { failures, advisories } = run(
    { "terraform/main.tf": 'policy_arn = "arn:aws:iam::aws:policy/SomeGenuinePolicyNobodyListed"\n' },
    iamContractFailures
  );
  assert.deepEqual(failures, []);
  assert.equal(advisories.length, 1);
  assert.match(advisories[0], /NOT evidence of a wrong one/);
});

// --- IRSA trust policies -------------------------------------------------------------------------

test("a correct IRSA trust policy is clean", () => {
  const { failures } = run({ "k8s/sa.yaml": sa(GOOD_ARN), "terraform/iam.tf": role(IRSA_TRUST) }, iamContractFailures);
  assert.deepEqual(failures, []);
});

test("a service-principal trust cannot be assumed by a pod", () => {
  const { failures } = run({ "k8s/sa.yaml": sa(GOOD_ARN), "terraform/iam.tf": role(EC2_TRUST) }, iamContractFailures);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /instance-profile trust/);
  assert.match(failures[0], /ec2\.amazonaws\.com/);
});

// Federated names the right party for the wrong call. Reporting this as "no principal" once sent a
// reader looking for something that was already there.
test("a Federated principal with plain sts:AssumeRole is reported precisely", () => {
  const { failures } = run(
    { "k8s/sa.yaml": sa(GOOD_ARN), "terraform/iam.tf": role(FEDERATED_WRONG_ACTION) },
    iamContractFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /rather than sts:AssumeRoleWithWebIdentity/);
});

test("the missing OIDC provider is called out when there is none", () => {
  const { failures } = run({ "k8s/sa.yaml": sa(GOOD_ARN), "terraform/iam.tf": role(EC2_TRUST) }, iamContractFailures);
  assert.match(failures[0], /no aws_iam_openid_connect_provider/);
});

// --- placeholder annotations ---------------------------------------------------------------------

test("a placeholder annotation is a finding, not a skipped line", () => {
  const { failures } = run({ "k8s/sa.yaml": sa("<ROLE_ARN>") }, iamContractFailures);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /are not a role ARN/);
});

test("a non-numeric account field is a placeholder", () => {
  const { failures } = run({ "k8s/sa.yaml": sa("arn:aws:iam::ACCOUNT_ID:role/app-role") }, iamContractFailures);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /are not a role ARN/);
});

// ${...} belongs to the k8s manifest check; one defect must not carry two names.
test("a ${...} annotation is left to the manifest check", () => {
  const { failures } = run({ "k8s/sa.yaml": sa("arn:aws:iam::${var.account_id}:role/app-role") }, iamContractFailures);
  assert.deepEqual(failures, []);
});

// A bad ARN must not also cost the trust verdict on the role it names.
test("a placeholder account still gets its trust policy judged", () => {
  const { failures } = run(
    { "k8s/sa.yaml": sa("arn:aws:iam::ACCOUNT_ID:role/app-role"), "terraform/iam.tf": role(EC2_TRUST) },
    iamContractFailures
  );
  assert.equal(failures.length, 2, "the placeholder AND the unusable trust policy");
});

test("no IRSA annotation means the check reports nothing rather than passing silently", () => {
  const r = run({ "terraform/iam.tf": role(EC2_TRUST) }, checkIrsa);
  assert.equal(r.ran, false);
  assert.match(r.unknown, /no ServiceAccount declares an IRSA role annotation/);
});

// --- the webhook-9 findings ----------------------------------------------------------------------
// The best-engineered deliverable of nine had a correct IRSA trust policy that could never bind,
// for two independent reasons. Both are name mismatches between artifacts that are each valid alone.

test("a trust policy pinning the wrong ServiceAccount is reported", () => {
  const { failures } = run(
    {
      "k8s/sa.yaml": sa(GOOD_ARN),
      "terraform/iam.tf":
        'resource "aws_iam_openid_connect_provider" "eks" { url = "https://oidc.eks.example" }\n' +
        role(IRSA_TRUST.replace("}", '}\n        Condition = { StringEquals = { "oidc:sub" = "system:serviceaccount:default:wrong-name" } }')),
    },
    iamContractFailures
  );
  const f = failures.find((x) => /ServiceAccount that does not exist/.test(x));
  assert.ok(f, "the subject mismatch must be reported");
  assert.match(f, /pins default:wrong-name/);
  assert.match(f, /the ServiceAccount is default:app-sa/);
  assert.match(f, /Correct shape, wrong subject/);
});

test("a trust policy pinning the right ServiceAccount is clean", () => {
  const { failures } = run(
    {
      "k8s/sa.yaml": sa(GOOD_ARN),
      "terraform/iam.tf":
        'resource "aws_iam_openid_connect_provider" "eks" { url = "https://oidc.eks.example" }\n' +
        role(IRSA_TRUST.replace("}", '}\n        Condition = { StringEquals = { "oidc:sub" = "system:serviceaccount:default:app-sa" } }')),
    },
    iamContractFailures
  );
  assert.deepEqual(failures, []);
});

// Interpolated role names must be resolved, or every project looks mismatched.
test("a role name built from a variable default is matched, not flagged", () => {
  const { failures } = run(
    {
      "k8s/sa.yaml": sa("arn:aws:iam::123456789012:role/proj-app-role"),
      "terraform/vars.tf": 'variable "project_name" {\n  default = "proj"\n}\n',
      "terraform/iam.tf":
        'resource "aws_iam_openid_connect_provider" "eks" { url = "https://oidc.eks.example" }\n' +
        'resource "aws_iam_role" "pod" {\n  name = "${var.project_name}-app-role"\n\n  assume_role_policy = jsonencode({\n    Statement = [\n      {\n' +
        IRSA_TRUST +
        '\n        Condition = { StringEquals = { "oidc:sub" = "system:serviceaccount:default:app-sa" } }\n      }\n    ]\n  })\n}\n',
    },
    iamContractFailures
  );
  assert.deepEqual(failures, []);
});

// Promoted from advisory — but only when the project actually defines roles of its own.
test("an annotation naming an undefined role blocks when the project defines roles", () => {
  const { failures } = run(
    { "k8s/sa.yaml": sa("arn:aws:iam::123456789012:role/nowhere-role"), "terraform/iam.tf": role(IRSA_TRUST) },
    iamContractFailures
  );
  const f = failures.find((x) => /does not define/.test(x));
  assert.ok(f);
  assert.match(f, /silently gets no credentials/);
});

test("the same annotation only advises when the project defines no roles at all", () => {
  const { failures, advisories } = run(
    { "k8s/sa.yaml": sa("arn:aws:iam::123456789012:role/managed-elsewhere") },
    iamContractFailures
  );
  assert.deepEqual(failures, []);
  assert.equal(advisories.length, 1);
  assert.match(advisories[0], /presumably managed\s+elsewhere/);
});

// --- IRSA declared through Terraform --------------------------------------------------------------

const TF_SA = (annotation) =>
  'resource "kubernetes_service_account" "app" {\n  metadata {\n    name = "app-sa"\n' +
  `    annotations = {\n      "eks.amazonaws.com/role-arn" = ${annotation}\n    }\n  }\n}\n`;

const TF_ROLE_OK =
  'resource "aws_iam_openid_connect_provider" "eks" { url = "https://oidc.eks.example" }\n' +
  'resource "aws_iam_role" "pod" {\n  name = "app-role"\n  assume_role_policy = jsonencode({\n    Statement = [{\n' +
  '      Action = "sts:AssumeRoleWithWebIdentity"\n      Principal = { Federated = aws_iam_openid_connect_provider.eks.arn }\n' +
  '      Condition = { StringEquals = { "oidc:sub" = "system:serviceaccount:default:app-sa" } }\n    }]\n  })\n}\n';

// A resource reference is the CORRECT way to write the annotation and resolves by label. Treating
// it as a placeholder would punish exactly the projects doing this properly.
test("an annotation referencing the role resource is resolved, not called malformed", () => {
  const { failures } = run(
    { "terraform/k8s.tf": TF_SA("aws_iam_role.pod.arn"), "terraform/iam.tf": TF_ROLE_OK },
    iamContractFailures
  );
  assert.deepEqual(failures, []);
});

test("a Terraform ServiceAccount still gets its trust policy judged", () => {
  const badTrust = TF_ROLE_OK.replace('"sts:AssumeRoleWithWebIdentity"', '"sts:AssumeRole"').replace(
    "Federated = aws_iam_openid_connect_provider.eks.arn",
    'Service = "ec2.amazonaws.com"'
  );
  const { failures } = run(
    { "terraform/k8s.tf": TF_SA("aws_iam_role.pod.arn"), "terraform/iam.tf": badTrust },
    iamContractFailures
  );
  assert.ok(failures.find((f) => /instance-profile trust/.test(f)));
});

test("a Terraform ServiceAccount gets its :sub compared too", () => {
  const wrongSub = TF_ROLE_OK.replace("default:app-sa", "default:app");
  const { failures } = run(
    { "terraform/k8s.tf": TF_SA("aws_iam_role.pod.arn"), "terraform/iam.tf": wrongSub },
    iamContractFailures
  );
  const f = failures.find((x) => /ServiceAccount that does not exist/.test(x));
  assert.ok(f);
  assert.match(f, /pins default:app,/);
});

test("a hand-written placeholder in Terraform is still a finding", () => {
  const { failures } = run(
    { "terraform/k8s.tf": TF_SA('"<ROLE_ARN>"'), "terraform/iam.tf": TF_ROLE_OK },
    iamContractFailures
  );
  assert.ok(failures.find((f) => /are not a role ARN/.test(f)));
});

// --- the managed-policy list ----------------------------------------------
// 37 hardcoded names meant most real policies came back "not in this check's known list", an
// advisory in most graded runs that correctly said it was evidence of nothing. The list is now
// parsed from AWS's own reference page by bench/fetch-managed-policies.sh -- parsed, not
// transcribed, because a fabricated name would be silently accepted as real, which is the single
// failure this check exists to prevent.
const attach = (...names) => ({
  "iam.tf": names
    .map((n, i) => `resource "aws_iam_role_policy_attachment" "a${i}" {\n  policy_arn = "arn:aws:iam::aws:policy/${n}"\n}`)
    .join("\n"),
});

test("the fixture carries a real list, not a handful of names", () => {
  // A partial list is safe but useless; this guards against the generator silently writing one.
  const names = readFileSync(new URL("./fixtures/aws-managed-policies.txt", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"));
  assert.ok(names.length > 1000, `only ${names.length} names in the fixture`);
  assert.ok(names.includes("AdministratorAccess"));
  assert.ok(!names.includes("NotARealPolicyName"));
});

// Every policy name the six graded deliverables actually attached. Each of these drew a "not in
// this check's known list" advisory before.
for (const name of [
  "AmazonRDSEnhancedMonitoringRole",
  "AmazonECSTaskExecutionRolePolicy",
  "AWSBackupServiceRolePolicyForBackup",
  "AmazonEKSClusterPolicy",
  "AmazonEKSWorkerNodePolicy",
]) {
  test(`a real managed policy is recognised: ${name}`, () => {
    const r = run(attach(name), (d) => checkManagedPolicies(d));
    assert.deepEqual(r.wrong, []);
    assert.deepEqual(r.unverifiable, []);
  });
}

test("a policy reached through a service-role path is recognised", () => {
  const r = run(
    { "iam.tf": 'policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"' },
    (d) => checkManagedPolicies(d)
  );
  assert.deepEqual(r.unverifiable, []);
  assert.deepEqual(r.wrong, []);
});

// A near miss is still reported as wrong, and the suggestion must be the closest real name. With
// 37 candidates the first prefix match was almost always right; with 1585 it is whichever sorts
// first, and AmazonEBSCSID_Policy drew "did you mean AmazonEBSCSIDriverEKSClusterScopedPolicy?"
// while AmazonEBSCSIDriverPolicy sat right there. A wrong suggestion beside a correct verdict
// teaches the reader to skim the verdict.
for (const [typo, expected] of [
  ["AmazonEBSCSID_Policy", "AmazonEBSCSIDriverPolicy"],
  ["AmazonEKSWorkerNodePolcy", "AmazonEKSWorkerNodePolicy"],
]) {
  test(`a typo is reported with the closest real name: ${typo}`, () => {
    const r = run(attach(typo), (d) => checkManagedPolicies(d));
    assert.equal(r.wrong.length, 1);
    assert.equal(r.wrong[0].near, expected);
  });
}

// Absence from a dated file is not proof a policy does not exist -- AWS adds them continually --
// so a name with no near miss stays advisory rather than blocking.
test("an unrecognised name with no near miss is advisory, not wrong", () => {
  const r = run(attach("TotallyInventedPolicyName"), (d) => checkManagedPolicies(d));
  assert.deepEqual(r.wrong, []);
  assert.equal(r.unverifiable.length, 1);
});
