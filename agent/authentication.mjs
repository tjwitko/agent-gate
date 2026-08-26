// Blocking check for the second requirement advice never fixed.
//
// Across the five preserved reviews, "no endpoint authenticates" appears in 5 of 5, and six runs
// later an audit log still accepted writes from anyone who could reach it. It is the same shape
// immutability had before that became a gate: stated every time, agreed with, not done.
//
// It is worth blocking for a reason particular to this task. An immutable store filled by
// anonymous writers is a tamper-proof record of unattributable claims -- the storage guarantees
// get stronger while the evidentiary value stays zero. Tampering and Spoofing have to be closed
// together or neither is worth much.
//
// Two rules carried over from the immutability check, for the same reasons:
//   1. An undetermined answer is an advisory, never a pass.
//   2. It judges per route, not per project. A real run authenticated POST and left GET open, and
//      a project-level "is there any auth" test would have called that done.

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

import { SKIP_DIRS } from "./skip-dirs.mjs";


// FastAPI and Flask route decorators. The method is captured so failures can name the route.
const ROUTE_RE = /@(\w+)\.(get|post|put|patch|delete|route)\(\s*["']([^"']*)["']([^)]*)\)/g;

// Endpoints that are conventionally open, and should be: a liveness probe that requires a
// credential is a liveness probe that fails.
const OPEN_BY_CONVENTION = /^\/(health|healthz|readyz?|livez?|ping|metrics)\b/i;

// A dependency that authenticates, as opposed to one that supplies a database session. This
// distinction is the whole check: a real run had `Depends(get_db)` on every route and
// authenticated none of them, so anything matching on `Depends(` alone would pass it.
const AUTH_DEPENDENCY = /\b(Security|Depends)\s*\(\s*(\w*(auth|verify|current_user|require|api_?key|token|principal|identity)\w*)/i;

// An API-key style header parameter. Restricted to credential-shaped names so an ordinary header
// such as `user_agent: str = Header(None)` is not mistaken for authentication.
const AUTH_HEADER_PARAM = /\b(x_api_key|api_key|authorization|x_auth_token|access_token|bearer)\b\s*:[^,)]*Header\s*\(/i;

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
    } else if (e.name.endsWith(".py")) {
      try {
        if (statSync(full).size <= 512 * 1024) acc.push({ rel: path.relative(root, full), text: readFileSync(full, "utf8") });
      } catch {
        /* unreadable is not this check's problem */
      }
    }
  }
  return acc;
}

// The decorator plus the `def` line that follows it. Auth can be declared in either: as
// `dependencies=[...]` on the decorator, or as a parameter in the signature.
function routeBlocks(text) {
  const lines = text.split("\n");
  const out = [];
  ROUTE_RE.lastIndex = 0;
  let m;
  while ((m = ROUTE_RE.exec(text))) {
    const decorator = m[0];
    const lineNo = text.slice(0, m.index).split("\n").length;
    // Signature can wrap across lines; take enough to cover it without running into the body.
    const signature = lines
      .slice(lineNo, lineNo + 8)
      .join("\n")
      .split(/:\s*(?:\n|$)/)[0];
    out.push({ method: m[2].toUpperCase(), route: m[3], decorator, signature, line: lineNo });
  }
  return out;
}

/** Per-route authentication state. Returns { ran, routes, unknown }. */
export function checkAuthentication(projectDir) {
  const files = walk(projectDir);
  if (files.length === 0) return { ran: false, routes: [], unknown: "no Python source files found" };

  const all = files.map((f) => f.text).join("\n");
  // Applied to every route at once, so a single declaration protects the whole surface.
  const globalAuth =
    /FastAPI\s*\([^)]*dependencies\s*=/.test(all) ||
    /APIRouter\s*\([^)]*dependencies\s*=/.test(all) ||
    /add_middleware\s*\(\s*\w*(Auth|Authentication|Security)\w*/i.test(all);

  const routes = [];
  for (const file of files) {
    for (const r of routeBlocks(file.text)) {
      if (OPEN_BY_CONVENTION.test(r.route)) continue;
      const protectedBy =
        globalAuth ? "an application-wide dependency"
        : /dependencies\s*=/.test(r.decorator) ? "a route dependency"
        : AUTH_DEPENDENCY.test(r.signature) ? "an auth dependency"
        : AUTH_HEADER_PARAM.test(r.signature) ? "a credential header"
        : null;
      routes.push({ file: file.rel, method: r.method, route: r.route, line: r.line, protectedBy });
    }
  }

  if (routes.length === 0) {
    return {
      ran: true,
      routes: [],
      unknown:
        "no HTTP routes were identified, so nothing was checked. If this service exposes endpoints, " +
        "they are declared in a form this check does not recognise",
    };
  }
  return { ran: true, routes, unknown: null };
}

/** Blocking failures for the gate. */
export function authenticationFailures(projectDir) {
  const report = checkAuthentication(projectDir);
  if (!report.ran) return { failures: [], advisories: [`authentication: not checked — ${report.unknown}`] };
  if (report.unknown) return { failures: [], advisories: [`authentication: ${report.unknown}`] };

  const open = report.routes.filter((r) => !r.protectedBy);
  if (open.length === 0) return { failures: [], advisories: [] };

  const list = open.map((r) => `${r.method} ${r.route} (${r.file}:${r.line})`).join(", ");
  const someProtected = report.routes.some((r) => r.protectedBy);
  return {
    failures: [
      `authentication: ${open.length} of ${report.routes.length} endpoint(s) accept requests from ` +
        `anyone who can reach the service — ${list}.\n` +
        (someProtected
          ? `Other routes here are authenticated, so this is a gap rather than an omission: an ` +
            `attacker uses the unprotected one. `
          : "") +
        `Unauthenticated writes damage an audit log more than unauthenticated reads: a log anyone ` +
        `can append to proves nothing about the records already in it, and an immutable store ` +
        `filled by anonymous writers is a tamper-proof record of unattributable claims. Require a ` +
        `caller identity on every route — a FastAPI dependency (Depends/Security) on the route or ` +
        `on the app, or a credential header the handler verifies. Health and readiness probes are ` +
        `exempt and need no change.`,
    ],
    advisories: [],
  };
}
