import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { terraformRoots } from "./agent-loop.mjs";

function run(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "tfroots-"));
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

const rel = (dir, dirs) => dirs.map((d) => path.relative(dir, d) || ".").sort();

// A deliverable that split its infrastructure into terraform/modules/{vpc,rds,eks,security_groups}
// -- the first here to modularise, and the right way to write it -- drew four blocking findings,
// one per module, every one "provider-authentication". Only the root declares a provider, and
// planning a child module standalone is meaningless. The gate was penalising the better practice.
test("a called child module is not a root", () => {
  run(
    {
      "terraform/main.tf": `
        provider "aws" { region = "us-east-1" }
        module "vpc" { source = "./modules/vpc" }
        module "rds" { source = "./modules/rds" }`,
      "terraform/modules/vpc/main.tf": `resource "aws_vpc" "this" { cidr_block = "10.0.0.0/16" }`,
      "terraform/modules/rds/main.tf": `resource "aws_db_instance" "this" { engine = "postgres" }`,
    },
    (dir) => assert.deepEqual(rel(dir, terraformRoots(dir)), ["terraform"])
  );
});

// Read from the source attribute, not guessed from the path: "modules" in a name proves nothing.
test("a directory named modules that nothing calls is still a root", () => {
  run(
    {
      "modules/main.tf": `provider "aws" {}\nresource "aws_s3_bucket" "b" { bucket = "x" }`,
    },
    (dir) => assert.deepEqual(rel(dir, terraformRoots(dir)), ["modules"])
  );
});

test("two independent roots are both kept", () => {
  run(
    {
      "terraform/main.tf": `provider "aws" {}\nresource "aws_s3_bucket" "a" { bucket = "a" }`,
      "storage/main.tf": `provider "aws" {}\nresource "aws_s3_bucket" "b" { bucket = "b" }`,
    },
    (dir) => assert.deepEqual(rel(dir, terraformRoots(dir)), ["storage", "terraform"])
  );
});

test("a module called from a parent directory is excluded", () => {
  run(
    {
      "envs/prod/main.tf": `provider "aws" {}\nmodule "net" { source = "../../modules/net" }`,
      "modules/net/main.tf": `resource "aws_vpc" "this" { cidr_block = "10.0.0.0/16" }`,
    },
    (dir) => assert.deepEqual(rel(dir, terraformRoots(dir)), ["envs/prod"])
  );
});

// A registry module is not a local directory and must not exclude anything.
test("a registry source excludes nothing", () => {
  run(
    {
      "terraform/main.tf": `
        provider "aws" {}
        module "eks" { source = "terraform-aws-modules/eks/aws" }`,
      "terraform/extra/main.tf": `resource "aws_s3_bucket" "b" { bucket = "x" }`,
    },
    (dir) => assert.deepEqual(rel(dir, terraformRoots(dir)), ["terraform", "terraform/extra"])
  );
});

test("a project with no Terraform has no roots", () => {
  run({ "src/index.mjs": "export const x = 1;\n" }, (dir) =>
    assert.deepEqual(terraformRoots(dir), [])
  );
});
