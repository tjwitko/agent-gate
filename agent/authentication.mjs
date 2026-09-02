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

// A credential-shaped header parameter. This was a fixed list of six names
// (x_api_key|api_key|authorization|x_auth_token|access_token|bearer), which reported a real
// support endpoint guarded by `x_internal_token: str = Header(None)` as open to anyone -- the same
// defect class as the JS inline-arrow false positive: a hardcoded list of spellings standing in
// for a test of shape. Matched on the credential-ish WORD a name contains instead, so
// x_internal_token, support_api_key and admin_secret all resolve without enumerating them.
//
// Signature headers are deliberately NOT credential words here. A machine sender proves identity
// by signing the payload, and that path demands corroboration that something actually verifies
// the signature; letting `x_provider_signature` match as a plain credential would hand a route
// protection merely for naming the header.
const PY_CREDENTIAL_HEADER_PARAM =
  /\b(\w*(?:api_?key|token|secret|credential|authorization)\w*)\s*:[^,)=]*=\s*Header\s*\(/i;

// Declaring the parameter is not checking it. Widening the names above without this would widen
// the surface for the worse error -- a gate that INVENTS protection is more dangerous than one
// that misses it -- so a credential header only counts when the handler both references the
// parameter and has a path that rejects the request. Mirrors the corroboration the signature
// branch already required via verifiesSignature().
const PY_AUTH_REJECTION = /\bstatus_code\s*=\s*(?:401|403)\b|\babort\s*\(\s*(?:401|403)\b|\bPermissionError\b|\bHTTPException\s*\(\s*(?:401|403)\b/;

// A request-signature header, which is how a webhook sender proves identity: there is no bearer
// token because the caller is a machine that signs each payload with a shared secret. This check
// reported such an endpoint as unauthenticated on a real webhook receiver -- a false positive, and
// one only a different task shape would have surfaced, since every earlier run used API keys.
const SIGNATURE_HEADER_PARAM =
  /\b(x[_-]?(hub[_-]?)?signature(_?256)?|signature|x[_-]?\w+[_-]signature|stripe[_-]signature)\b\s*[:=]/i;

// Evidence that the file actually verifies a signature, rather than merely accepting the header.
// The same discipline that keeps Depends(get_db) from counting as authentication: a parameter is
// not a control until something checks it.
const VERIFIES_SIGNATURE = [
  /\bhmac\.(new|compare_digest)\s*\(/,          // Python
  /\bcreateHmac\s*\(/,                           // Node
  /\btimingSafeEqual\s*\(/,                      // Node
  /\bOpenSSL::HMAC\b/,                            // Ruby
  /\bhmac\.New\s*\(|hmac\.Equal\s*\(/,        // Go
  /\bMac\.getInstance\s*\(/,                    // Java
];

function verifiesSignature(all) {
  return VERIFIES_SIGNATURE.some((re) => re.test(all));
}

// Constant-time comparison, which is the only safe way to check a signature.
const CONSTANT_TIME_COMPARE = /\b(compare_digest|timingSafeEqual|hmac\.Equal|MessageDigest\.isEqual|secure_compare)\s*\(/;

// An ordinary equality test against something signature-shaped. `==` returns on the first differing
// byte, so an attacker who can send repeated callbacks recovers the digest one byte at a time
// without ever learning the secret -- the canonical way webhook verification is broken. Recognising
// a signature as authentication without saying this would leave the gate certifying a control with
// an exploitable leak in it, which is worse than not recognising it at all.
const LEAKY_SIGNATURE_COMPARE =
  /\b\w*(signature|digest|hmac|hash)\w*\s*(===?|!==?)|(===?|!==?)\s*\w*(signature|digest|hmac)\w*\b/i;

// A credential read from the environment with a defaulting getter, so it can be undefined at
// runtime. Compared with == or != against what the caller sent, an unset value makes the check
// vacuous: in Python `None != None` is false, so a missing environment variable does not fail
// closed -- it opens the endpoint.
//
// Found by hand-testing a webhook receiver that authenticated both routes, passed this gate, and
// served every stored callback to an unauthenticated request because its Deployment never set
// SUPPORT_API_KEY. The same file validated three other environment variables at startup and not
// these two. A gate that confirms a check exists, without asking whether it can be satisfied by
// nothing, certifies exactly this.
// process.env.X is undefined when unset, and `undefined !== undefined` is false -- the same
// vacuous comparison as Python's os.getenv, in the language the second webhook receiver used.
const JS_ENV_CREDENTIAL =
  /\b(?:const|let|var)\s+(\w*(?:[Kk]ey|[Ss]ecret|[Tt]oken|[Pp]assword|[Cc]redential)\w*)\s*=\s*process\.env\.(\w+)/g;
// Or read inline at the comparison site: `req.headers['x'] !== process.env.SUPPORT_TEAM_KEY`.
const JS_INLINE_ENV_COMPARE = /[!=]==?\s*process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\.([A-Z_][A-Z0-9_]*)\s*[!=]==?/g;

function jsValidatedAtStartup(all, name) {
  return [
    new RegExp(`if\\s*\\(\\s*!\\s*${name}\\b`),
    new RegExp(`if\\s*\\([^)]*${name}\\s*===?\\s*undefined`),
    new RegExp(`${name}\\s*\\?\\?`),                       // ?? fallback
    new RegExp(`process\\.env\\.${name}\\s*\\|\\|`),   // || default
    new RegExp(`throw[^\\n]*${name}`),
    new RegExp(`assert[^\\n]*${name}`),
  ].some((re) => re.test(all));
}

const PY_ENV_CREDENTIAL =
  /^\s*([A-Z_][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*=\s*os\.(?:getenv\s*\(|environ\.get\s*\()/gm;

function validatedAtStartup(all, name) {
  const patterns = [
    new RegExp(`if\\s+not\\s+${name}\\b`),
    new RegExp(`if\\s+${name}\\s+is\\s+None`),
    new RegExp(`if\\s*\\(?\\s*not\\s+${name}\\b`),
    new RegExp(`${name}\\s*=\\s*os\\.environ\\[`),            // raises KeyError when absent
    new RegExp(`assert\\s+${name}\\b`),
    // A default only rescues the check if it is a real value. `os.getenv("X", "")` was accepted
    // here, which exempted the exact defect this function exists to find: unset, the expected
    // credential becomes the empty string and the comparison is against `"Bearer "`. Requires at
    // least one character inside the quotes.
    new RegExp(`${name}\\s*=\\s*os\\.(getenv|environ\\.get)[^\\n]*,\\s*(?:'[^']|"[^"]|\`[^\`])`),
  ];
  return patterns.some((re) => re.test(all));
}

/** Credentials compared against an environment value that may be unset, making the check vacuous. */
export function vacuousCredentialChecks(all) {
  const out = [];
  for (const re of [JS_ENV_CREDENTIAL, JS_INLINE_ENV_COMPARE]) {
    re.lastIndex = 0;
    let j;
    while ((j = re.exec(all))) {
      const local = j[2] ? j[1] : null;                 // `const local = process.env.ENV`
      const envName = j[2] || j[1] || j[3];
      if (!envName || !/key|secret|token|password|credential/i.test(envName)) continue;
      // Validation, like the comparison, is usually written against the local alias rather than
      // the env expression -- `const expectedKey = process.env.X; if (!expectedKey) ...`.
      if ([envName, local].filter(Boolean).some((n) => jsValidatedAtStartup(all, n))) continue;
      // The comparison is usually against the local alias, not the env expression. Missing that
      // is why this check saw nothing in a deliverable that had the defect.
      const names = [envName, local].filter(Boolean);
      const compared = names.some((n) =>
        new RegExp(`[!=]==?[^\\n]*\\b${n}\\b|\\b${n}\\b[^\\n]*[!=]==?`).test(all)
      );
      if (compared) out.push(envName);
    }
  }
  PY_ENV_CREDENTIAL.lastIndex = 0;
  let m;
  while ((m = PY_ENV_CREDENTIAL.exec(all))) {
    const name = m[1];
    if (validatedAtStartup(all, name)) continue;
    // Adjacency to the operator is too strict: `authorization != f"Bearer {SUPPORT_TEAM_TOKEN}"`
    // hides the name inside an f-string, and the original pattern saw no comparison at all. Same
    // line as a comparison is the test, which also covers template literals in JS.
    const compared = new RegExp(`[!=]==?[^\\n]*\\b${name}\\b|\\b${name}\\b[^\\n]*[!=]==?`).test(all);
    if (compared) out.push(name);
  }
  return [...new Set(out)];
}

/** A signature is verified somewhere, but not in constant time. */
// The same timing leak on a credential that is not a signature. Kept separate from the signature
// check on purpose, for the reason recorded on CONSTANT_TIME_COMPARE: timingSafeEqual is how ANY
// secret should be compared, so folding the two together would report a bearer-token check as
// signature verification. Same verdict, wrong reason given to the reader.
//
// Observed in webhook-5, comparing a support token with `x_internal_token != internal_token`. A
// support token is a better target than a signature, not a worse one: the caller may retry freely,
// and unlike a per-payload digest the value is stable across every attempt, so a timing oracle
// recovers one secret that then works forever.
// The word list is shared with PY_CREDENTIAL_HEADER_PARAM on purpose. They drifted once: that one
// learned `authorization` and this one did not, so a route recognised as protected BY an
// authorization header was never checked for how it compares one. `authorization != f"Bearer ..."`
// went unreported in a graded deliverable for exactly that reason -- two lists in one file,
// disagreeing about what a credential is called.
const CREDENTIAL_WORD = "api_?key|token|secret|credential|password|authorization|bearer";
// Both operands are captured, because the credential word next to an equality operator is not on
// its own evidence of anything. `typeof apiKey !== "string"` is a type guard, and reporting it as a
// timing leak blocked a deliverable whose credential comparison used crypto.timingSafeEqual two
// files away. Four of that run's ten validation rounds went into a finding that was never real.
// What matters is what the credential is being compared TO: another value leaks it a byte at a
// time, whereas null, a type name or a number tells an attacker only whether the header was sent.
const LEAKY_CREDENTIAL_COMPARE = new RegExp(
  `(typeof\\s+)?\\b(\\w*(?:${CREDENTIAL_WORD})\\w*)\\s*(?:===?|!==?)\\s*([^\\s;,)]+)` +
    `|([^\\s;,(]+)\\s*(?:===?|!==?)\\s*(typeof\\s+)?\\b(\\w*(?:${CREDENTIAL_WORD})\\w*)\\b`,
  "gi"
);

// Operands that carry no secret. Comparing against any of these is a presence or type check: it
// reveals whether a header arrived, not what it contained.
const NON_SECRET_OPERAND =
  /^(?:null|undefined|true|false|none|nil|-?\d+(?:\.\d+)?|["'`](?:|string|object|number|boolean|undefined|function|symbol|bigint)["'`])[;,)\]}]*$/i;

export function leakyCredentialCheck(all) {
  // Deliberately NOT gated on the file containing a constant-time comparison somewhere. That
  // file-wide bail-out is what made this check miss the case it was written for: webhook-5 used
  // hmac.compare_digest for the signature and a bare `!=` for the support token, so one correct
  // comparison suppressed the report of an incorrect one. A constant-time call uses no equality
  // operator, so a match here is evidence on its own.
  //
  // Every match is examined rather than only the first. A single benign comparison appearing
  // earlier in the file must not stand in for the rest -- that is the same short-circuit as the
  // file-wide bail-out, one scope down.
  for (const m of all.matchAll(LEAKY_CREDENTIAL_COMPARE)) {
    const typeofPrefix = m[1] || m[5];
    const name = m[2] || m[6] || "";
    const other = (m[3] || m[4] || "").trim();
    // `typeof cred === ...` asks what kind of thing arrived, never what it is.
    if (typeofPrefix) continue;
    if (NON_SECRET_OPERAND.test(other)) continue;
    // A signature compared loosely is the OTHER check's finding; reporting it here too would give
    // one defect two names.
    if (/signature|digest|hmac/i.test(name)) continue;
    return name;
  }
  return false;
}

export function leakySignatureCheck(all) {
  if (!verifiesSignature(all)) return false;
  if (CONSTANT_TIME_COMPARE.test(all)) return false;
  return LEAKY_SIGNATURE_COMPARE.test(all);
}

// The handler's own body: everything from the `def` until the indentation returns to column 0,
// which for a module-level route function is the next decorator or top-level statement. Bounded by
// a dedent rather than a line count so it neither truncates a long handler nor runs into the next
// one -- reading past a handler into its neighbour is how an unauthenticated route once got
// credited with another route's verification.
function pyRouteBody(lines, startIdx) {
  const out = [];
  for (let i = startIdx; i < lines.length && out.length < 300; i++) {
    const l = lines[i];
    if (out.length && l.trim() && !/^\s/.test(l)) break;
    out.push(l);
  }
  return out.join("\n");
}

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
      out.push({
        method: m[2].toUpperCase(),
        route: m[3],
        declaration: m[0],
        context: signature,
        body: pyRouteBody(lines, line),
        line,
      });
    }
    return out;
  },

  globalAuth(all) {
    if (/FastAPI\s*\([^)]*dependencies\s*=/.test(all)) return "an application-wide dependency";
    if (/APIRouter\s*\([^)]*dependencies\s*=/.test(all)) return "a router-wide dependency";
    if (/add_middleware\s*\(\s*\w*(Auth|Authentication|Security)\w*/i.test(all)) return "authentication middleware";
    return null;
  },

  routeAuth(r, all) {
    if (/dependencies\s*=/.test(r.declaration)) return "a route dependency";
    if (PY_AUTH_DEPENDENCY.test(r.context)) return "an auth dependency";
    const credential = PY_CREDENTIAL_HEADER_PARAM.exec(r.context);
    if (credential) {
      const name = credential[1];
      const body = r.body || "";
      const referenced = new RegExp(`\\b${name}\\b`).test(body);
      if (referenced && PY_AUTH_REJECTION.test(body)) return "a credential header";
    }
    if (SIGNATURE_HEADER_PARAM.test(r.context) && verifiesSignature(all)) return "a verified request signature";
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

// The identifiers a route hands its request to, e.g.
// `app.post('/webhook', express.raw({...}), handleWebhook)`. JS_ROUTE_RE stops at the comma after
// the path, so the handlers are in the route's trailing context, not in its declaration -- reading
// the declaration finds nothing at all, which is why an earlier attempt at this resolved no handler
// and reported a verified endpoint as open.
//
// Every bare identifier up to the closing paren is a candidate: Express takes a chain of
// middleware and the verifier may be any of them, not only the last.
function routeHandlerNames(context) {
  const call = context.slice(0, context.indexOf(");") + 1 || context.length);
  return [...call.matchAll(/(^|[,\s(])([A-Za-z_$][\w$]*)\s*(?=[,)])/g)].map((m) => m[2]);
}

// The handler's own body, bounded by its braces. A fixed-size window instead of this read past the
// end of one handler into the next file -- the adapter searches a concatenation of every file in
// the language, so 2500 characters from an unauthenticated handler reached signature code that
// belonged to a different route, and reported the unauthenticated one as verified.
function functionBodyAt(text, start) {
  const open = text.indexOf("{", start);
  if (open === -1) return text.slice(start, start + 400);
  let depth = 0;
  for (let i = open; i < text.length && i < open + 20000; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start, open + 2500);
}

// An inline handler -- `app.post(PATH, (req, res) => { ... })` -- gives routeHandlerNames no
// identifier to resolve, so a route whose verification lives in an arrow body read as unverified.
// Confirmed by holding the logic constant and varying only the handler shape: named-and-guarded
// passed, named-with-the-guard-removed flagged (so the check is live in that shape), and
// inline-and-guarded flagged with the identical guard. Inline arrows are ordinary Express, and of
// the two directions this one is the false positive -- the direction that gets a gate switched off.
//
// The body is brace-matched from the arrow's own position rather than read out of `route.context`:
// that window is capped at 300 characters and 4 lines on purpose, so a long handler cannot drag an
// unrelated `auth` mention into the decision, and widening it would trade this false positive for
// that false negative.
const INLINE_HANDLER_HEAD =
  /(?:\([^()]{0,200}\)|[A-Za-z_$][\w$]*)\s*=>\s*\{|function\s*\*?\s*[A-Za-z_$]*\s*\([^()]{0,200}\)\s*\{/g;

// The extent of the route call itself. The search for inline bodies is bounded by the call's own
// closing paren so it cannot run into the next route: an earlier fixed-size window did exactly
// that and credited one route with signature code belonging to another.
function callExtent(text, startOfCall) {
  const open = text.indexOf("(", startOfCall);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length && i < open + 20000; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return [open, i];
    }
  }
  return [open, Math.min(text.length, open + 20000)];
}

/** Bodies of every inline function expression passed to this route call. */
function inlineHandlerBodies(text, startOfCall) {
  const extent = callExtent(text, startOfCall);
  if (!extent) return [];
  const [open, close] = extent;
  const bodies = [];
  let i = open;
  for (let guard = 0; guard < 12 && i < close; guard++) {
    INLINE_HANDLER_HEAD.lastIndex = 0;
    const m = INLINE_HANDLER_HEAD.exec(text.slice(i, close));
    if (!m) break;
    const headAt = i + m.index;
    const body = functionBodyAt(text, headAt);
    bodies.push(body);
    i = headAt + Math.max(body.length, 1);
  }
  return bodies;
}

/**
 * Every handler body this route actually runs: the inline functions passed to the route call, plus
 * the body of each handler it names.
 *
 * Shared by the signature and credential checks on purpose. They were written separately, and the
 * credential one resolved handlers by identifier only -- so an inline arrow, which has no
 * identifier, was judged unauthenticated while the identical guard in a named middleware passed.
 * That is the same defect the signature check had fixed one commit earlier, one path over, and
 * keeping one resolver is what stops it being fixed twice and regressed once.
 */
function routeHandlerBodies(route, all) {
  const bodies = [...(route.inlineBodies || [])];
  // A framework route names its handler in the declaration; a hand-rolled dispatch branch just
  // calls it, and the guard may be another call or two down. Expanded against `all` rather than the
  // declaring file, because the chain crosses files as a matter of course.
  if (route.followChain) {
    for (const seed of route.inlineBodies || []) bodies.push(...reachableBodies(all, seed));
  }
  // Each named handler's own body, not the whole corpus: a project that verifies a signature
  // somewhere must not thereby mark every route protected. A first attempt did exactly that and
  // reported an unauthenticated support endpoint as safe, which is worse than missing one.
  for (const name of routeHandlerNames(route.context)) {
    const def = new RegExp(`(?:export\\s+)?(?:const|let|var|function|async\\s+function)\\s+${name}\\b`).exec(all);
    if (!def) continue;
    bodies.push(functionBodyAt(all, def.index));
  }
  return bodies;
}

// A credential arriving in a header, read from the request inside the handler.
const JS_CREDENTIAL_HEADER_READ =
  /req\.headers\s*\[\s*['"`][^'"`]*(?:key|token|secret|auth)[^'"`]*['"`]\s*\]|req\.headers\.(?:authorization|apikey|api_?key)|req\.get\s*\(\s*['"`][^'"`]*(?:key|token|secret|auth)[^'"`]*['"`]\s*\)/i;

// The handler refusing the request. Without this a handler that merely reads the header would count,
// which is the `Depends(get_db)` mistake in another language: a value is not a control until
// something acts on it.
const JS_AUTH_REJECTION =
  /\.status\s*\(\s*(?:401|403)\b|\.sendStatus\s*\(\s*(?:401|403)\b|\bUnauthorized\b|\bForbidden\b|\bthrow\b/;

/** Does the handler this route runs read a credential from the request and refuse without it? */
function handlerChecksCredential(route, all) {
  for (const body of routeHandlerBodies(route, all)) {
    if (JS_CREDENTIAL_HEADER_READ.test(body) && JS_AUTH_REJECTION.test(body)) return true;
  }
  return false;
}

/** Does the handler this route names actually verify a signature? */
function handlerVerifiesSignature(route, all) {
  if (!verifiesSignature(all)) return false;              // nothing in the project verifies anything
  const bodies = routeHandlerBodies(route, all);
  if (bodies.length === 0) return false;
  for (const body of bodies) {
    // Constructing an HMAC, not merely comparing in constant time. timingSafeEqual on its own is
    // how any secret should be compared -- a support API key included -- so accepting it as
    // evidence of a *signature* labels a key check as signature verification. The verdict is the
    // same either way; the reason given to the reader is not.
    if (/verif\w*signature|checkSignature|validateSignature/i.test(body)) return true;
    if (/\bcreateHmac\s*\(|\bhmac\.new\s*\(|OpenSSL::HMAC|hmac\.New\s*\(/.test(body)) return true;
  }
  return false;
}


// --- routing without a framework -------------------------------------------
// A deliverable served a webhook endpoint, a health endpoint and a support lookup from a single
// node:http handler -- `req.method === "POST" && url.pathname === "/webhooks/payment-provider"` --
// and this check, which knows Express, Fastify, Nest and the Python decorators, found no routes at
// all. It said so honestly and blocked nothing, which is the correct behaviour for an unreadable
// project and still meant a blocking security check contributed nothing to that run. Zero
// dependencies is a defensible choice and must not buy exemption from the auth gate.
const NODE_HTTP_DISPATCH =
  /\b(?:req|request)\.method\s*===?\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]([\s\S]{0,300}?)\)\s*\{/gi;
const PATHNAME_LITERAL = /\b(?:pathname|path|url)\s*===?\s*["'`](\/[^"'`]*)["'`]/gi;
// `const m = ROUTE_RE.exec(url.pathname)` followed by `if (req.method === "GET" && m)`.
const REGEX_MATCH_BINDING = /(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\s*\.\s*(?:exec|match)\s*\(/g;

// The literal prefix of a path regex, with each capture group named as a parameter:
// /^\/callbacks\/([^/]+)$/ -> /callbacks/:param. Enough to judge whether the route is open by
// convention and to name it in a finding; it is not a router.
function pathFromRegexSource(src) {
  const body = src.replace(/^\//, "").replace(/\/[gimsuy]*$/, "").replace(/^\^/, "").replace(/\$$/, "");
  const out = body.replace(/\(\?:[^)]*\)|\([^)]*\)/g, ":param").replace(/\\\//g, "/");
  return /^\//.test(out) ? out : `/${out}`;
}


const MAX_CALL_DEPTH = 3;
const MAX_BODIES = 40;

// Definitions of `name`, in the forms a handler chain actually uses: a declared function or const,
// and a method in a class or object literal (`async receive(a, b) {`). The `)` followed by `{` is
// what separates a definition from a call site.
function definitionOf(text, name) {
  const declared = new RegExp(`(?:export\\s+)?(?:async\\s+)?(?:const|let|var|function)\\s+${name}\\b`).exec(text);
  if (declared) return declared.index;
  const method = new RegExp(`(?:^|[{;,]|\\n)\\s*(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`, "m").exec(text);
  return method ? method.index : -1;
}

/** The starting body plus every body reachable from it by name, to a bounded depth. */
function reachableBodies(text, startBody) {
  const bodies = [startBody];
  const seen = new Set();
  let frontier = [startBody];
  for (let depth = 0; depth < MAX_CALL_DEPTH && bodies.length < MAX_BODIES; depth++) {
    const next = [];
    for (const b of frontier) {
      // Bare calls and method calls alike: the guard may sit behind `service.receive(...)`.
      for (const m of b.matchAll(/(?:\.\s*)?\b([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = m[1];
        if (seen.has(name) || RESERVED_CALL.test(name)) continue;
        seen.add(name);
        const at = definitionOf(text, name);
        if (at === -1) continue;
        const body = functionBodyAt(text, at);
        bodies.push(body);
        next.push(body);
        if (bodies.length >= MAX_BODIES) return bodies;
      }
    }
    frontier = next;
  }
  return bodies;
}

// Language and library names that are never a handler, kept out so the walk spends its budget on
// the project's own code.
const RESERVED_CALL =
  /^(if|for|while|switch|catch|return|typeof|await|new|function|require|import|Promise|Object|Array|String|Number|Boolean|JSON|Math|Date|Error|Buffer|Map|Set|console|process|parseInt|parseFloat|test|expect|describe|it)$/;

function nodeHttpRoutes(text, lineAt) {
  const out = [];
  NODE_HTTP_DISPATCH.lastIndex = 0;
  let m;
  while ((m = NODE_HTTP_DISPATCH.exec(text))) {
    const method = m[1].toUpperCase();
    const condition = m[2];
    const blockStart = m.index + m[0].length - 1;
    const body = functionBodyAt(text, blockStart);

    const paths = [...condition.matchAll(PATHNAME_LITERAL)].map((p) => p[1]);

    // A path held in a regex constant, reached through a match binding named in the condition.
    if (paths.length === 0) {
      const before = text.slice(Math.max(0, m.index - 400), m.index);
      REGEX_MATCH_BINDING.lastIndex = 0;
      let b;
      while ((b = REGEX_MATCH_BINDING.exec(before))) {
        if (!new RegExp(`\\b${b[1]}\\b`).test(condition)) continue;
        // Greedy to the LAST slash on the line: a path regex almost always contains a character
        // class like [^/], and a scanner that stops at the first unescaped slash truncated
        // /^\/callbacks\/([^/]+)$/ into "/callbacks/([^".
        const decl = new RegExp(`(?:const|let|var)\\s+${b[2]}\\s*=\\s*(/.*/[gimsuy]*)\\s*;?[ \\t]*$`, "m").exec(text);
        if (decl) paths.push(pathFromRegexSource(decl[1]));
      }
    }
    if (paths.length === 0) continue;

    // Every function this branch reaches, not only the one it calls directly. Without following the
    // chain, a correct deliverable read as unprotected: the branch calls handleWebhook, which calls
    // webhookService.receive, which is where verifySignature lives. Reporting that route as having
    // no signature check would be a false positive in a blocking gate, which destroys work rather
    // than merely missing something. Bounded in depth and count so this stays a lookup, not an
    // interpreter.
    // Only the branch body here. The chain is followed later, against the whole-language corpus:
    // this function sees one file, and the handler it calls routinely lives in another --
    // handleWebhook is in app.js, the receive() that verifies the signature is in webhookService.js.
    const bodies = [body];

    for (const route of paths) {
      out.push({
        method,
        route,
        declaration: m[0],
        context: condition,
        inlineBodies: bodies,
        followChain: true,
        line: lineAt(m.index),
      });
    }
  }
  return out;
}

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
      out.push({
        method: m[2].toUpperCase(),
        route: m[4],
        declaration: m[0],
        context: tail,
        inlineBodies: inlineHandlerBodies(text, m.index),
        line: lineAt(m.index),
      });
    }

    out.push(...nodeHttpRoutes(text, lineAt));

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
      // The chain group is the trailing capture, so its offset is fixed from the match's end --
      // needed because JS_CHAIN_VERB_RE reads a substring while inline bodies must be brace-matched
      // against the real file. Its `[^)]*` argument capture also stops at the first `)`, which an
      // inline arrow's own parameter list supplies, so `context` alone cannot see an inline guard.
      const chainStart = m.index + m[0].length - chain.length;
      JS_CHAIN_VERB_RE.lastIndex = 0;
      let v;
      while ((v = JS_CHAIN_VERB_RE.exec(chain))) {
        // Each verb carries its own middleware list, so they are judged separately -- the whole
        // point of this check is that `.get(handler).post(requireAuth, handler)` is a gap.
        out.push({
          method: v[1].toUpperCase(),
          route,
          declaration: v[0],
          context: v[2],
          inlineBodies: inlineHandlerBodies(text, chainStart + v.index),
          line,
        });
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

  routeAuth(r, all) {
    if (/@UseGuards\s*\(/.test(r.context)) return "a route guard";
    // A machine sender proves identity by signing the payload, not with a bearer token. Taught to
    // the Python adapter after a webhook receiver was wrongly reported open, and not to this one,
    // so the next receiver -- TypeScript -- was wrongly reported open too.
    //
    // Resolved per route rather than file-wide. A first attempt accepted any route in a project
    // that verified a signature anywhere, which marked an unauthenticated support endpoint as
    // protected: worse than the false positive it replaced, because a gate that invents protection
    // is more dangerous than one that misses it. Express handlers are named imports, so the route
    // names its handler and the handler's body is what has to do the verifying.
    if (handlerVerifiesSignature(r, all)) return "a verified request signature";
    // Resolved through the same bodies as the signature check. Without this an inline arrow that
    // reads a credential header and refuses without it was reported open, while the identical guard
    // moved into a named middleware passed -- a false positive decided by handler shape alone.
    if (handlerChecksCredential(r, all)) return "a credential checked in the handler";
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
  let leakySignature = false;
  let leakyCredential = false;
  const vacuous = new Set();
  for (const [adapter, adapterFiles] of byAdapter) {
    const all = adapterFiles.map((f) => f.text).join("\n");
    const global = adapter.globalAuth(all);
    if (leakySignatureCheck(all)) leakySignature = true;
    const leakyCred = leakyCredentialCheck(all);
    if (leakyCred) leakyCredential = leakyCred;
    for (const n of vacuousCredentialChecks(all)) vacuous.add(n);
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
  return { ran: true, routes, languages, leakySignature, leakyCredential, vacuousCredentials: [...vacuous], unknown: null };
}

/** Blocking failures for the gate. */
export function authenticationFailures(projectDir) {
  const report = checkAuthentication(projectDir);
  if (!report.ran) return { failures: [], advisories: [`authentication: not checked — ${report.unknown}`] };
  if (report.unknown) return { failures: [], advisories: [`authentication: ${report.unknown}`] };

  // Reported whether or not any route is open, and separately from the open-route finding: a
  // service can authenticate every endpoint and still have a leaky comparison in the one control
  // that matters. Conflating the two would let a fix for one hide the other.
  const timing = report.leakySignature
    ? [
        `authentication: a request signature is verified with an ordinary equality comparison ` +
          `rather than a constant-time one. \`==\` returns as soon as it finds a differing byte, so ` +
          `an attacker who can send repeated callbacks measures response times and recovers the ` +
          `correct digest one byte at a time, without ever learning the secret. This is the ` +
          `canonical way signature verification is broken. Use hmac.compare_digest (Python), ` +
          `crypto.timingSafeEqual (Node), hmac.Equal (Go) or the equivalent, and compare the raw ` +
          `digests rather than their hex strings where the language offers it.`,
      ]
    : [];

  if (report.leakyCredential) {
    timing.push(
      `authentication: the credential \`${report.leakyCredential}\` is compared with an ordinary ` +
        `equality operator rather than a constant-time one. The leak is the same as for a signature, ` +
        `and the payoff is larger: a bearer credential is stable across attempts, so timing that ` +
        `recovers it once yields a value that keeps working, where a per-payload digest does not. ` +
        `The caller can also retry as often as it likes. Use hmac.compare_digest (Python), ` +
        `crypto.timingSafeEqual (Node), hmac.Equal (Go) or the equivalent.`
    );
  }

  const vacuousNames = report.vacuousCredentials || [];
  if (vacuousNames.length) {
    timing.push(
      `authentication: ${vacuousNames.join(", ")} ${vacuousNames.length === 1 ? "is" : "are"} read ` +
        `from the environment with a getter that returns None when unset, and compared with == or ` +
        `!= against what the caller sent. When the variable is missing the comparison is between ` +
        `two Nones, which succeeds — so a deployment that forgets it does not fail closed, it ` +
        `serves the endpoint to anyone. Validate at startup and refuse to start without it, the ` +
        `way this file already treats its other required configuration, and compare with ` +
        `hmac.compare_digest so the check is constant-time as well as non-vacuous.`
    );
  }

  const open = report.routes.filter((r) => !r.protectedBy);
  if (open.length === 0) return { failures: timing, advisories: [] };

  const list = open.map((r) => `${r.method} ${r.route} (${r.file}:${r.line})`).join(", ");
  const someProtected = report.routes.some((r) => r.protectedBy);
  const idioms = [...new Set(report.languages.map((n) => ADAPTERS.find((a) => a.name === n).idiom))];

  return {
    failures: [
      ...timing,
      `authentication: ${open.length} of ${report.routes.length} endpoint(s) accept requests from ` +
        `anyone who can reach the service — ${list}.\n` +
        (someProtected
          ? `Other routes here are authenticated, so this is a gap rather than an omission: an ` +
            `attacker uses the unprotected one. `
          : "") +
        `Unauthenticated writes damage a system of record more than unauthenticated reads: a store anyone ` +
        `can append to proves nothing about the records already in it, and an immutable store ` +
        `filled by anonymous writers is a tamper-proof record of unattributable claims. Require a ` +
        `caller identity on every route — ${idioms.join("; or ")}. Health and readiness probes are ` +
        `exempt and need no change, as are endpoints whose job is to issue a credential.`,
    ],
    advisories: [],
  };
}
