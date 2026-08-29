import test from "node:test";
import assert from "node:assert/strict";
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
