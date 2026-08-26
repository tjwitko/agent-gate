// One definition of "directories that are not the project's own code", for every walk in this
// repo's agent loop.
//
// `.external_modules` is the entry that matters and the reason this file exists. Checkov puts
// modules downloaded with --download-external-modules there, inside the project rather than beside
// it, and it was missing from five separate walks across this workspace — each found only when it
// caused a different failure: a scan whose every finding came from third-party code, a gate that
// discovered 2,499 Terraform roots and ran init against all of them, a commit that could not be
// made, a run killed by a 143,066-token request, and a lockfile probe that reported an unlocked
// project as locked.
//
// local-copilot-stack and terraform-guard-mcp keep their own copies on purpose: importing a
// constant across optional sibling repos would put a load-order risk inside a security control.
// Their tests pin the value. If you add an entry here, add it there too.
export const SKIP_DIRS = new Set([
  ".git",
  ".terraform",
  ".external_modules",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
]);
