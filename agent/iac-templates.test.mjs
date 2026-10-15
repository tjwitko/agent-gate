import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import path from "path";

import { findIacTemplates, iacTemplateAdvisories } from "./iac-templates.mjs";

const CFN = 'AWSTemplateFormatVersion: "2010-09-09"\nResources:\n  Bucket:\n    Type: AWS::S3::Bucket\n    Properties:\n      AccessControl: PublicRead\n';
const CFN_NO_VERSION = 'Resources:\n  Queue:\n    Type: "AWS::SQS::Queue"\n';
const ARM =
  '{\n  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",\n  "contentVersion": "1.0.0.0",\n' +
  '  "resources": [ { "type": "Microsoft.Storage/storageAccounts", "apiVersion": "2021-04-01", "name": "store", "location": "eastus",' +
  ' "sku": { "name": "Standard_LRS" }, "kind": "StorageV2", "properties": { "supportsHttpsTrafficOnly": false } } ]\n}\n';
const BICEP =
  "resource store 'Microsoft.Storage/storageAccounts@2021-04-01' = {\n  name: 'store'\n  location: 'eastus'\n" +
  "  sku: { name: 'Standard_LRS' }\n  kind: 'StorageV2'\n  properties: { supportsHttpsTrafficOnly: false }\n}\n";

function project(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "iac-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const within = (files, fn) => {
  const d = project(files);
  try {
    return fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};
const rel = (d, found) => Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.map((f) => path.relative(d, f))]));

test("templates are found by content, not by name", () => {
  const got = within(
    {
      "infra/stack.yaml": CFN,
      "infra/queue.yml": CFN_NO_VERSION,
      "azure/azuredeploy.json": ARM,
      "azure/main.bicep": BICEP,
      "k8s/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\n",
      ".github/workflows/ci.yml": "on: push\njobs: {}\n",
      "package.json": '{"name":"p"}',
      "node_modules/x/template.yaml": CFN,
    },
    (d) => rel(d, findIacTemplates(d))
  );
  assert.deepEqual(got, { cloudformation: ["infra/queue.yml", "infra/stack.yaml"].sort(), arm: ["azure/azuredeploy.json"], bicep: ["azure/main.bicep"] });
});

test("a project with no templates reports nothing", () => {
  assert.deepEqual(within({ "main.tf": 'resource "aws_s3_bucket" "b" {}\n' }, iacTemplateAdvisories), { failures: [], advisories: [] });
});

const haveCheckov = spawnSync("checkov", ["--version"]).status === 0;
test("checkov's findings on each template are advisories, never findings", { skip: !haveCheckov && "checkov not installed" }, () => {
  const r = within({ "stack.yaml": CFN, "azuredeploy.json": ARM, "main.bicep": BICEP }, iacTemplateAdvisories);
  assert.deepEqual(r.failures, []);
  const text = r.advisories.join("\n");
  assert.match(text, /iac templates \(CloudFormation\): checkov reports \d+ finding\(s\), not blocking — stack\.yaml: CKV_AWS_/);
  assert.match(text, /iac templates \(ARM\): checkov reports \d+ finding\(s\).*azuredeploy\.json: CKV_AZURE_/);
  assert.match(text, /iac templates \(Bicep\): checkov reports \d+ finding\(s\).*main\.bicep: CKV_AZURE_/);
});

test("without checkov, the templates are reported as not scanned", () => {
  const bin = mkdtempSync(path.join(tmpdir(), "nocheckov-"));
  const dir = project({ "stack.yaml": CFN });
  try {
    symlinkSync(process.execPath, path.join(bin, "node"));
    const src = `import { iacTemplateAdvisories } from ${JSON.stringify(new URL("./iac-templates.mjs", import.meta.url).href)};
      console.log(JSON.stringify(iacTemplateAdvisories(${JSON.stringify(dir)})));`;
    const r = spawnSync(path.join(bin, "node"), ["--input-type=module", "-e", src], { encoding: "utf8", env: { PATH: bin } });
    assert.match(JSON.parse(r.stdout).advisories[0], /checkov is not installed, so 1 CloudFormation template\(s\) were not scanned/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
