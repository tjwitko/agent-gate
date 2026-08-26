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
// Three rules shape everything here. The first two are carried over from the immutability check:
//   1. An undetermined answer is an advisory, never a pass.
//   2. It judges per route, not per project. A real run authenticated POST and left GET open, and
//      a project-level "is there any auth" test would have called that done.
//   3. **A false positive is worse than a miss.** A gate that blocks correct code gets switched
//      off, and then it protects nothing at all. Every pattern below is therefore narrow, and the
//      places where breadth was tempting are marked with the specific thing that would break.
//
// LANGUAGE COVERAGE. This was Python-only, which made it inert on the project type this repo
// benchmarks most: run against the Node/Express reference project -- no authentication anywhere --
// it reported "not checked, no Python source files found" and could not block. A gate that reads
// one language while the work happens in another is an advisory with extra steps.
//
// Recognised now: Python (FastAPI, Flask), JavaScript/TypeScript (Express, Fastify, NestJS), Go
// (net/http, chi, gin, echo, gorilla), Java (Spring), Ruby (Sinatra, Rails). Each is an entry in
// ADAPTERS: it claims file extensions, finds routes, and answers whether a route is protected. The
// judgment above that -- conventional exemptions, per-route verdicts, how an undetermined answer is
// reported -- is shared, so a new language is an adapter and not a second policy.
//
// NOT recognised, deliberately: PHP, C#, Rust, and every framework whose routing is data rather
// than code (an OpenAPI document, a Rails `routes.rb` mapped to controllers, an API-gateway
// config). Those are not misses to fix casually -- routing declared as data needs the handler
// resolved before "is this route authenticated" is even answerable, and guessing there produces
// exactly the false positives rule 3 exists to prevent. They fall through to the undetermined
// path, which reports rather than passes.

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

import { SKIP_DIRS } from "./skip-dirs.mjs";

// Endpoints that are conventionally open, and should be: a liveness probe that requires a
// credential is a liveness probe that fails.
const OPEN_BY_CONVENTION = /^\/(health|healthz|readyz?|livez?|ping|metrics|favicon\.ico)\b/i;

// Endpoints whose job is to issue a credential cannot require one first. Terminal names only:
// exempting the whole `/auth/**` prefix would hide `/auth/admin/users`, which is a real route with
// a real risk.
const CREDENTIAL_ISSUING = /^\/(?:api\/)?(?:v\d+\/)?(?:auth\/)?(login|signin|sign-in|logout|signout|sign-out|register|signup|sign-up|token|oauth|oauth2|callback)\/?$/i;

// Identifiers that indicate authentication rather than any other middleware. Deliberately excludes
// `login` and `session`: a handler named `loginHandler` is the thing that issues the credential,
// not a thing that checks one, and `session` alone is just as often a database session -- the same
// confusion that made `Depends(get_db)` look like auth in the original Python check.
const AUTH_WORD =
  /(authenticat|authoriz|\bauth\b|auth[A-Z_]|[a-z_]auth|verifyToken|verifyJwt|requireUser|requireAuth|ensureAuth|ensureLogged|isAuthenticated|checkAuth|currentUser|current_user|principal|identity|jwt|bearer|passport|api_?key|apiKey|access_?token|guard|protect)/i;

const MAX_FILE_BYTES = 512 * 1024;

// Test files declare routes that are not the service's attack surface, and they quote route calls
// as fixture text. Found by running this check over this very repo: 15 phantom routes came from
// `authentication.test.mjs`, whose fixtures quote route calls as ordinary strings.
// A phantom route has no middleware, so it is reported unprotected, so it would block a correct
// project -- rule 3's exact failure mode. Matched on the filename rather than the directory,
// because `test/` and `tests/` sometimes hold real application code, while these suffixes do not.
const TEST_FILE =
  /(\.(test|spec)\.[mc]?[jt]sx?|_test\.go|_test\.py|_spec\.rb|_test\.rb|Test\.java|Tests\.java)$|^test_[^/]*\.py$|^conftest\.py$/i;
const TEST_DIRS = new Set(["__tests__", "__mocks__", "fixtures", "testdata"]);

// ---------------------------------------------------------------------------------------------
// Python -- FastAPI and Flask
// ---------------------------------------------------------------------------------------------

const PY_ROUTE_RE = /@(\w+)\.(get|post|put|patch|delete|route)\(\s*["']([^"']*)["']([^)]*)\)/g;

// A dependency that authenticates, as opposed to one that supplies a database session. This
// distinction is the whole check: a real run had `Depends(get_db)` on every route and
// authenticated none of them, so anything matching on `Depends(` alone would pass it.
const PY_AUTH_DEPENDENCY =
  /\b(Security|Depends)\s*\(\s*(\w*(auth|verify|current_user|require|api_?key|token|principal|identity)\w*)/i;

// An API-key style header parameter. Restricted to credential-shaped names so an ordinary header
// such as `user_agent: str = Header(None)` is not mistaken for authentication.
const PY_AUTH_HEADER_PARAM =
  /\b(x_api_key|api_key|authorization|x_auth_token|access_token|bearer)\b\s*:[^,)]*Header\s*\(/i;

const pythonAdapter = {
  name: "Python",
  extensions: [".py"],
  idiom: "a FastAPI dependency (Depends/Security) on the route or on the app, or a credential header the handler verifies",

  routes(text) {
    const lines = text.split("\n");
    const out = [];
    PY_ROUTE_RE.lastIndex = 0;
    let m;
    while ((m = PY_ROUTE_RE.exec(text))) {
      const line = text.slice(0, m.index).split("\n").length;
      // Signature can wrap across lines; take enough to cover it without running into the body.
      const signature = lines.slice(line, line + 8).join("\n").split(/:\s*(?:\n|$)/)[0];
      out.push({ method: m[2].toUpperCase(), route: m[3], declaration: m[0], context: signature, line });
    }
    return out;
  },

  globalAuth(all) {
    if (/FastAPI\s*\([^)]*dependencies\s*=/.test(all)) return "an application-wide dependency";
    if (/APIRouter\s*\([^)]*dependencies\s*=/.test(all)) return "a router-wide dependency";
    if (/add_middleware\s*\(\s*\w*(Auth|Authentication|Security)\w*/i.test(all)) return "authentication middleware";
    return null;
  },

  routeAuth(r) {
    if (/dependencies\s*=/.test(r.declaration)) return "a route dependency";
    if (PY_AUTH_DEPENDENCY.test(r.context)) return "an auth dependency";
    if (PY_AUTH_HEADER_PARAM.test(r.context)) return "a credential header";
    return null;
  },
};

// ---------------------------------------------------------------------------------------------
// JavaScript / TypeScript -- Express, Fastify, NestJS
// ---------------------------------------------------------------------------------------------

// Two conditions keep this off things that are not routes. The path must start with `/`, and a
// comma must follow it -- meaning at least one more argument. Without the comma this matches
// `app.get("port")`, which is Express's *settings getter* and appears in almost every Express app;
// without the leading slash it matches `map.delete("key")` and `cache.get("user:1")`.
const JS_ROUTE_RE =
  /\b(\w+)\s*\.\s*(get|post|put|patch|delete|all|head|options)\s*\(\s*(['"`])(\/[^'"`\n]*)\3\s*,/g;

// Fastify's object form: `.route({ method: METHOD, url: PATH, preHandler: auth })`. Written with
// identifiers rather than literals for the reason given on the jsAdapter idiom below.
const JS_FASTIFY_ROUTE_RE = /\.\s*route\s*\(\s*\{([\s\S]{0,600}?)\}\s*\)/g;

// Express's chained form: `.route(PATH).get(handler).post(requireAuth, handler)`. Distinct
// from Fastify's `.route(` by taking a string rather than an object, and easy to miss entirely --
// the chained verbs carry no path of their own, so JS_ROUTE_RE never sees them.
const JS_CHAIN_ROUTE_RE = /\.\s*route\s*\(\s*(['"`])(\/[^'"`]*)\1\s*\)((?:\s*\.\s*(?:get|post|put|patch|delete|all)\s*\([^;]*?\))+)/g;
const JS_CHAIN_VERB_RE = /\.\s*(get|post|put|patch|delete|all)\s*\(([^)]*)\)/g;

// NestJS controller methods. The path is optional -- a bare Post decorator with no argument means
// the controller's own base path --
// and auth is a decorator either on the method or on the class.
const JS_NEST_ROUTE_RE = /@(Get|Post|Put|Patch|Delete|All)\s*\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)/g;

const jsAdapter = {
  name: "JavaScript/TypeScript",
  extensions: [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"],
  // The example deliberately writes the path as an identifier rather than a quoted literal: this
  // string is source text in a file this same check may walk, and a quoted path followed by a
  // comma is exactly what JS_ROUTE_RE matches. Documenting a route shape must not declare one.
  idiom:
    "middleware on the route (`app.post(path, requireAuth, handler)`), an app-wide `app.use(requireAuth)`, a Fastify `preHandler`/`onRequest` hook, or a NestJS `@UseGuards(...)`",

  routes(text) {
    const lines = text.split("\n");
    const lineAt = (index) => text.slice(0, index).split("\n").length;
    const out = [];

    JS_ROUTE_RE.lastIndex = 0;
    let m;
    while ((m = JS_ROUTE_RE.exec(text))) {
      // Everything from the path to the end of the call is where route middleware lives. Bounded
      // so a long handler body cannot drag an unrelated `auth` mention into the decision.
      const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 300).split("\n").slice(0, 4).join("\n");
      out.push({ method: m[2].toUpperCase(), route: m[4], declaration: m[0], context: tail, line: lineAt(m.index) });
    }

    JS_FASTIFY_ROUTE_RE.lastIndex = 0;
    while ((m = JS_FASTIFY_ROUTE_RE.exec(text))) {
      const body = m[1];
      const url = body.match(/\burl\s*:\s*(['"`])(\/[^'"`]*)\1/);
      const method = body.match(/\bmethod\s*:\s*(['"`])(\w+)\1/);
      if (!url) continue;
      out.push({
        method: method ? method[2].toUpperCase() : "ANY",
        route: url[2],
        declaration: body,
        context: body,
        line: lineAt(m.index),
      });
    }

    JS_CHAIN_ROUTE_RE.lastIndex = 0;
    while ((m = JS_CHAIN_ROUTE_RE.exec(text))) {
      const route = m[2];
      const chain = m[3];
      const line = lineAt(m.index);
      JS_CHAIN_VERB_RE.lastIndex = 0;
      let v;
      while ((v = JS_CHAIN_VERB_RE.exec(chain))) {
        // Each verb carries its own middleware list, so they are judged separately -- the whole
        // point of this check is that `.get(handler).post(requireAuth, handler)` is a gap.
        out.push({ method: v[1].toUpperCase(), route, declaration: v[0], context: v[2], line });
      }
    }

    JS_NEST_ROUTE_RE.lastIndex = 0;
    while ((m = JS_NEST_ROUTE_RE.exec(text))) {
      const line = lineAt(m.index);
      // Guards sit above the route decorator, or above the class. Look back far enough for both.
      const before = lines.slice(Math.max(0, line - 4), line).join("\n");
      out.push({
        method: m[1].toUpperCase(),
        route: m[3] ? (m[3].startsWith("/") ? m[3] : `/${m[3]}`) : "/",
        declaration: m[0],
        context: before,
        line,
      });
    }

    return out;
  },

  globalAuth(all) {
    // `app.use(...)` mounting a router takes a path first; requiring the auth word inside the call
    // keeps `app.use("/api", router)` and `app.use(cors())` out of this.
    if (/\.\s*use\s*\(\s*[^)]{0,160}?(authenticat|authoriz|requireAuth|ensureAuth|isAuthenticated|checkAuth|jwt|passport|verifyToken|authMiddleware|\bauth\b)/i.test(all)) {
      return "app-wide authentication middleware";
    }
    if (/addHook\s*\(\s*(['"`])(onRequest|preHandler|preValidation)\1\s*,[^)]{0,120}?(auth|jwt|verify|token)/i.test(all)) {
      return "a Fastify authentication hook";
    }
    if (/@UseGuards\s*\([^)]*\)\s*(?:@\w+\s*(?:\([^)]*\))?\s*)*export\s+class/.test(all)) {
      return "a controller-wide guard";
    }
    return null;
  },

  routeAuth(r) {
    if (/@UseGuards\s*\(/.test(r.context)) return "a route guard";
    if (/\b(preHandler|onRequest|preValidation)\s*:/.test(r.declaration) && AUTH_WORD.test(r.declaration)) {
      return "a Fastify hook";
    }
    // Route middleware: an identifier between the path and the handler that names authentication.
    if (AUTH_WORD.test(r.context)) return "route middleware";
    return null;
  },
};

// ---------------------------------------------------------------------------------------------
// Go -- net/http, chi, gin, echo, gorilla/mux
// ---------------------------------------------------------------------------------------------

// `HandleFunc`/`Handle` carry no method, so those are reported as ANY rather than guessed at.
const GO_ROUTE_RE =
  /\b(\w+)\s*\.\s*(Get|Post|Put|Patch|Delete|GET|POST|PUT|PATCH|DELETE|HandleFunc|Handle)\s*\(\s*"(\/[^"]*)"\s*,/g;

const goAdapter = {
  name: "Go",
  extensions: [".go"],
  idiom: "middleware in the route's chain, or a router-wide `Use(...)` that verifies the caller",

  routes(text) {
    const out = [];
    GO_ROUTE_RE.lastIndex = 0;
    let m;
    while ((m = GO_ROUTE_RE.exec(text))) {
      const verb = m[2];
      const method = /^(HandleFunc|Handle)$/.test(verb) ? "ANY" : verb.toUpperCase();
      const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 240).split("\n").slice(0, 3).join("\n");
      out.push({
        method,
        route: m[3],
        declaration: m[0] + tail.split("\n")[0],
        context: tail,
        line: text.slice(0, m.index).split("\n").length,
      });
    }
    return out;
  },

  globalAuth(all) {
    if (/\.\s*Use\s*\(\s*[^)]{0,160}?(Auth|JWT|Token|Verify|RequireAuth|Identity)/.test(all)) {
      return "router-wide middleware";
    }
    return null;
  },

  routeAuth(r) {
    return AUTH_WORD.test(r.context) ? "middleware in the route's chain" : null;
  },
};

// ---------------------------------------------------------------------------------------------
// Java -- Spring MVC / Spring Security
// ---------------------------------------------------------------------------------------------

const JAVA_ROUTE_RE =
  /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?(?:\{\s*)?"(\/[^"]*)"/g;

const javaAdapter = {
  name: "Java",
  extensions: [".java"],
  idiom: "`@PreAuthorize`/`@Secured` on the handler, or a `SecurityFilterChain` requiring authentication",

  routes(text) {
    const lines = text.split("\n");
    const out = [];
    JAVA_ROUTE_RE.lastIndex = 0;
    let m;
    while ((m = JAVA_ROUTE_RE.exec(text))) {
      const line = text.slice(0, m.index).split("\n").length;
      // Spring's authorization annotations sit next to the mapping, either side of it.
      const around = lines.slice(Math.max(0, line - 4), line + 3).join("\n");
      const verb = m[1] === "Request" ? "ANY" : m[1].toUpperCase();
      out.push({ method: verb, route: m[2], declaration: m[0], context: around, line });
    }
    return out;
  },

  globalAuth(all) {
    if (/authorize(Http)?Requests[\s\S]{0,400}?(\.authenticated\(\)|hasRole|hasAuthority)/.test(all)) {
      return "a security filter chain requiring authentication";
    }
    return null;
  },

  routeAuth(r) {
    return /@(PreAuthorize|PostAuthorize|Secured|RolesAllowed)\b/.test(r.context) ? "an authorization annotation" : null;
  },
};

// ---------------------------------------------------------------------------------------------
// Ruby -- Sinatra, Rails controllers
// ---------------------------------------------------------------------------------------------

// Sinatra's `get "/logs" do`. Anchored to the start of a line so `response.get "/x"` inside a
// method body is not read as a route declaration.
const RUBY_ROUTE_RE = /^[ \t]*(get|post|put|patch|delete)\s+['"](\/[^'"]*)['"]\s*(?:,[^\n]*)?\s*(?:do\b|\{)/gim;

const rubyAdapter = {
  name: "Ruby",
  extensions: [".rb"],
  idiom: "a `before` filter or `before_action` that authenticates the caller",

  routes(text) {
    const out = [];
    RUBY_ROUTE_RE.lastIndex = 0;
    let m;
    while ((m = RUBY_ROUTE_RE.exec(text))) {
      const line = text.slice(0, m.index).split("\n").length;
      out.push({ method: m[1].toUpperCase(), route: m[2], declaration: m[0], context: m[0], line });
    }
    return out;
  },

  globalAuth(all) {
    if (/before_action\s+:[\w!?]*(authenticate|authoriz|require_login|require_user)/i.test(all)) {
      return "a controller-wide before_action";
    }
    if (/^[ \t]*before\s+(?:do\b|['"])[\s\S]{0,200}?(authenticate|authoriz|api_key|token|halt\s+401)/im.test(all)) {
      return "a Sinatra before filter";
    }
    return null;
  },

  routeAuth() {
    // Sinatra declares authentication in a `before` filter rather than on the route, so per-route
    // detection would report every route unprotected in a correctly-secured app. Global only.
    return null;
  },
};

const ADAPTERS = [pythonAdapter, jsAdapter, goAdapter, javaAdapter, rubyAdapter];

const ADAPTER_BY_EXT = new Map();
for (const a of ADAPTERS) for (const ext of a.extensions) ADAPTER_BY_EXT.set(ext, a);

const RECOGNISED = [...new Set(ADAPTERS.map((a) => a.name))].join(", ");

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
      if (!SKIP_DIRS.has(e.name) && !TEST_DIRS.has(e.name)) walk(full, acc, root);
      continue;
    }
    if (TEST_FILE.test(e.name)) continue;
    const adapter = ADAPTER_BY_EXT.get(path.extname(e.name));
    if (!adapter) continue;
    try {
      if (statSync(full).size <= MAX_FILE_BYTES) {
        acc.push({ rel: path.relative(root, full), text: readFileSync(full, "utf8"), adapter });
      }
    } catch {
      /* unreadable is not this check's problem */
    }
  }
  return acc;
}

/** Per-route authentication state. Returns { ran, routes, languages, unknown }. */
export function checkAuthentication(projectDir) {
  const files = walk(projectDir);
  if (files.length === 0) {
    return {
      ran: false,
      routes: [],
      languages: [],
      unknown: `no source files in a language this check recognises (${RECOGNISED})`,
    };
  }

  // Global auth is judged per language against that language's own files. A Python app-wide
  // dependency says nothing about an Express server sitting next to it in the same repo.
  const byAdapter = new Map();
  for (const f of files) {
    if (!byAdapter.has(f.adapter)) byAdapter.set(f.adapter, []);
    byAdapter.get(f.adapter).push(f);
  }

  const routes = [];
  const languages = [];
  for (const [adapter, adapterFiles] of byAdapter) {
    const all = adapterFiles.map((f) => f.text).join("\n");
    const global = adapter.globalAuth(all);
    let found = 0;
    for (const file of adapterFiles) {
      for (const r of adapter.routes(file.text)) {
        if (OPEN_BY_CONVENTION.test(r.route) || CREDENTIAL_ISSUING.test(r.route)) continue;
        found++;
        routes.push({
          file: file.rel,
          language: adapter.name,
          method: r.method,
          route: r.route,
          line: r.line,
          protectedBy: global || adapter.routeAuth(r, all),
        });
      }
    }
    if (found > 0) languages.push(adapter.name);
  }

  if (routes.length === 0) {
    return {
      ran: true,
      routes: [],
      languages: [],
      unknown:
        "no HTTP routes were identified, so nothing was checked. If this service exposes endpoints, " +
        "they are declared in a form this check does not recognise",
    };
  }
  return { ran: true, routes, languages, unknown: null };
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
  const idioms = [...new Set(report.languages.map((n) => ADAPTERS.find((a) => a.name === n).idiom))];

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
        `caller identity on every route — ${idioms.join("; or ")}. Health and readiness probes are ` +
        `exempt and need no change, as are endpoints whose job is to issue a credential.`,
    ],
    advisories: [],
  };
}
