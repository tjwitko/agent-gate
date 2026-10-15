// Infrastructure templates other than Terraform: CloudFormation, ARM and Bicep.
//
// The blocking infrastructure policies are terraform-guard's, and they judge Terraform on AWS. checkov
// was already installed and already run, advisory-only, but in its Terraform mode alone -- so a
// CloudFormation template or an Azure ARM or Bicep file was read by nothing, while checkov ships rules
// for all three. This runs them, at the same tier as checkov on Terraform: advisories, never findings.
//
// Terraform for Azure and GCP needed no change: checkov's Terraform mode already applies its rules for
// every provider. What it lacks there is a blocking policy, which is terraform-guard's to add.
//
// Files are found by content, not by name: a CloudFormation template is any YAML or JSON naming an
// AWS resource type or the template format version, and an ARM template is JSON naming Azure's
// deployment-template schema. A Kubernetes manifest or a GitHub workflow is neither.
import { readdirSync, readFileSync, statSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";

import { SKIP_DIRS } from "./skip-dirs.mjs";
import { isDeclaredFixture } from "./fixture-markers.mjs";

const MAX_FILE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 180_000;
const LABEL = { cloudformation: "CloudFormation", arm: "ARM", bicep: "Bicep" };

const CLOUDFORMATION = /\bAWSTemplateFormatVersion\b|^\s*["']?Type["']?\s*:\s*["']?AWS::\w+::/m;
const ARM = /schema\.management\.azure\.com\/schemas\/[^"']*deploymentTemplate\.json/;

export function findIacTemplates(projectDir) {
  const found = { cloudformation: [], arm: [], bicep: [] };
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !isDeclaredFixture(full)) walk(full);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      if (ext === ".bicep") {
        found.bicep.push(full);
        continue;
      }
      if (![".yaml", ".yml", ".json", ".template"].includes(ext)) continue;
      let text;
      try {
        if (statSync(full).size > MAX_FILE_BYTES) continue;
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (ext === ".json" && ARM.test(text)) found.arm.push(full);
      else if (CLOUDFORMATION.test(text)) found.cloudformation.push(full);
    }
  };
  walk(projectDir);
  return found;
}

export function iacTemplateAdvisories(projectDir) {
  const found = findIacTemplates(projectDir);
  const frameworks = Object.keys(found).filter((k) => found[k].length > 0);
  if (frameworks.length === 0) return { failures: [], advisories: [] };
  const files = frameworks.flatMap((k) => found[k]);
  const what = frameworks.map((k) => `${found[k].length} ${LABEL[k]}`).join(", ");

  if (spawnSync("checkov", ["--version"], { encoding: "utf8" }).status !== 0) {
    return {
      failures: [],
      advisories: [`iac templates: checkov is not installed, so ${what} template(s) were not scanned. Unknown, not clean.`],
    };
  }

  const run = spawnSync(
    "checkov",
    ["--framework", ...frameworks, "--compact", "-o", "json", ...files.flatMap((f) => ["-f", f])],
    { encoding: "utf8", timeout: TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 }
  );
  if (run.error || run.signal || !run.stdout) {
    return {
      failures: [],
      advisories: [`iac templates: checkov did NOT run to completion over ${what} template(s) (${run.signal || run.error?.message || `exit ${run.status}, no output`}). Unknown, not clean.`],
    };
  }
  let reports;
  try {
    const parsed = JSON.parse(run.stdout);
    reports = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return { failures: [], advisories: ["iac templates: checkov's output could not be parsed. Unknown, not clean."] };
  }

  const advisories = [];
  for (const r of reports) {
    const label = LABEL[r.check_type] || r.check_type;
    const failed = r.results?.failed_checks || [];
    const parseErrors = Number(r.summary?.parsing_errors || 0);
    const byFile = new Map();
    for (const c of failed) {
      const f = path.relative(projectDir, c.file_abs_path || c.file_path || "");
      if (!byFile.has(f)) byFile.set(f, new Set());
      byFile.get(f).add(`${c.check_id} ${c.check_name}`);
    }
    const detail = [...byFile].map(([f, s]) => `${f}: ${[...s].slice(0, 6).join("; ")}${s.size > 6 ? `; +${s.size - 6} more` : ""}`).join(" | ");
    advisories.push(
      `iac templates (${label}): checkov reports ${failed.length} finding(s), not blocking` +
        (failed.length ? ` — ${detail}` : "") +
        `.` +
        (parseErrors ? ` ${parseErrors} file(s) FAILED TO PARSE and were not scanned.` : "")
    );
  }
  return { failures: [], advisories };
}
