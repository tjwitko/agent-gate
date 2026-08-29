import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { checkAuthentication, authenticationFailures } from "./authentication.mjs";

// These fixtures often carry more than one real defect -- a credential compared with `!=` against
// an unset env var is BOTH vacuous and timing-unsafe. Asserting on totals would make every test
// brittle to a new finding; assert on the finding under test instead.
const vacuous = (failures) => failures.filter((f) => /does not fail closed/.test(f));

function run(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "auth-"));
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

// The trap this check exists to avoid. A real run had Depends(get_db) on every route and
// authenticated none of them; anything matching on `Depends(` alone would have passed it.
test("a database session dependency is not authentication", () => {
  const { failures } = run(
    {
      "app/main.py":
        "@app.post('/logs')\ndef create_log(log: X, db: Session = Depends(get_db)):\n    pass\n",
    },
    authenticationFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /POST \/logs/);
});

test("an auth dependency or a credential header counts", () => {
  const dep = run(
    { "app/main.py": "@app.get('/logs')\ndef read(user = Depends(get_current_user)):\n    pass\n" },
    authenticationFailures
  );
  assert.deepEqual(dep.failures, []);

  // The handler must actually CHECK the credential. `pass` here originally passed the gate, which
  // meant a handler that ignored its own api-key header was reported as authenticated.
  const header = run(
    {
      "app/main.py":
        "@app.post('/logs')\ndef add(x_api_key: str = Header(...)):\n" +
        "    if not compare_digest(x_api_key, API_KEY):\n        raise HTTPException(status_code=403)\n    pass\n",
    },
    authenticationFailures
  );
  assert.deepEqual(header.failures, []);
});

// Per route, not per project. A real run authenticated POST and left GET open; a project-level
// "is there any auth here" test would have called that done.
test("a partially protected surface still fails, and says so", () => {
  const { failures } = run(
    {
      "app/main.py":
        "@app.post('/logs')\ndef add(x_api_key: str = Header(...)):\n" +
        "    if not compare_digest(x_api_key, API_KEY):\n        raise HTTPException(status_code=403)\n    pass\n\n" +
        "@app.get('/logs')\ndef read(limit: int = 50):\n    pass\n",
    },
    authenticationFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /1 of 2 endpoint\(s\)/);
  assert.match(failures[0], /GET \/logs/);
  assert.match(failures[0], /gap rather than an omission/);
});

test("an application-wide dependency protects every route", () => {
  const { failures } = run(
    {
      "app/main.py":
        "app = FastAPI(dependencies=[Depends(verify_api_key)])\n\n" +
        "@app.get('/logs')\ndef read():\n    pass\n\n@app.post('/logs')\ndef add():\n    pass\n",
    },
    authenticationFailures
  );
  assert.deepEqual(failures, []);
});

test("a route-level dependencies= list counts", () => {
  const { failures } = run(
    {
      "app/main.py":
        "@app.get('/logs', dependencies=[Depends(verify_api_key)])\ndef read():\n    pass\n",
    },
    authenticationFailures
  );
  assert.deepEqual(failures, []);
});

// A liveness probe that requires a credential is a liveness probe that fails.
test("health and readiness probes are exempt", () => {
  const { failures } = run(
    {
      "app/main.py":
        "@app.get('/health')\ndef health():\n    pass\n\n" +
        "@app.get('/metrics')\ndef metrics():\n    pass\n",
    },
    authenticationFailures
  );
  assert.deepEqual(failures, []);
});

// Narrow on purpose: an ordinary header is not a credential, and a check that says otherwise
// reports every route as protected.
test("an ordinary header is not authentication", () => {
  const { failures } = run(
    { "app/main.py": "@app.get('/logs')\ndef read(user_agent: str = Header(None)):\n    pass\n" },
    authenticationFailures
  );
  assert.equal(failures.length, 1);
});

test("an undetermined answer is reported, never passed silently", () => {
  const report = run({ "app/util.py": "def helper():\n    return 1\n" }, checkAuthentication);
  assert.ok(report.unknown);
  const { failures, advisories } = run({ "app/util.py": "def helper():\n    return 1\n" }, authenticationFailures);
  assert.deepEqual(failures, []);
  assert.equal(advisories.length, 1);
});

// ---------------------------------------------------------------------------------------------
// JavaScript / TypeScript
//
// The reason this file grew. Run against this repo's own Express reference project -- which
// authenticates nothing -- the Python-only check reported "not checked, no Python source files
// found" and could not block. These pin the behaviour that replaced it.
// ---------------------------------------------------------------------------------------------

test("express: an unprotected route fails, and names method and path", () => {
  const { failures } = run(
    { "src/app.js": "const app = express();\napp.post('/logs', (req, res) => res.send('ok'));\n" },
    authenticationFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /POST \/logs/);
});

test("express: route middleware counts as authentication", () => {
  const { failures } = run(
    { "src/app.js": "app.post('/logs', requireAuth, (req, res) => res.send('ok'));\n" },
    authenticationFailures
  );
  assert.deepEqual(failures, []);
});

test("express: an app-wide use() protects every route", () => {
  const { failures } = run(
    { "src/app.js": "app.use(authenticateRequest);\napp.get('/logs', list);\napp.post('/logs', create);\n" },
    authenticationFailures
  );
  assert.deepEqual(failures, []);
});

// The single most likely false positive in Express, and the reason the path must start with `/`
// and be followed by a comma: `app.get(name)` is the settings *getter*, and it appears in
// virtually every Express application.
test("express: app.get('port') is a settings read, not a route", () => {
  const report = run(
    { "src/app.js": "app.set('port', 3000);\nconst port = app.get('port');\nconst env = app.get('env');\n" },
    checkAuthentication
  );
  assert.equal(report.routes.length, 0);
  assert.ok(report.unknown, "no routes reported, and that is undetermined rather than a pass");
});

// Same guard, different shape: ordinary collection calls take string keys too.
test("express: map.delete and cache.get are not routes", () => {
  const report = run(
    {
      "src/store.js":
        "cache.get('user:1');\nsessions.delete('abc');\nheaders.get('content-type');\napp.post('/logs', create);\n",
    },
    checkAuthentication
  );
  assert.equal(report.routes.length, 1);
  assert.equal(report.routes[0].route, "/logs");
});

test("express: non-auth middleware does not count as authentication", () => {
  const { failures } = run(
    {
      "src/app.js":
        "app.use(cors());\napp.use(express.json());\napp.use(morgan('dev'));\napp.post('/logs', create);\n",
    },
    authenticationFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /POST \/logs/);
});

// `login` is deliberately absent from the auth vocabulary: a handler that issues a credential is
// not a handler that checks one.
test("express: a handler named loginHandler does not protect a route", () => {
  const { failures } = run({ "src/app.js": "app.post('/logs', loginHandler);\n" }, authenticationFailures);
  assert.equal(failures.length, 1);
});

test("express: chained app.route() is judged per verb", () => {
  const { failures } = run(
    { "src/app.js": "app.route('/logs')\n  .get(list)\n  .post(requireAuth, create);\n" },
    authenticationFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /GET \/logs/);
  assert.doesNotMatch(failures[0], /POST \/logs/);
});

test("fastify: a preHandler hook counts, its absence does not", () => {
  const withHook = run(
    {
      "src/server.js":
        "fastify.route({ method: 'POST', url: '/logs', preHandler: fastify.authenticate, handler: create });\n",
    },
    authenticationFailures
  );
  assert.deepEqual(withHook.failures, []);

  const without = run(
    { "src/server.js": "fastify.route({ method: 'POST', url: '/logs', handler: create });\n" },
    authenticationFailures
  );
  assert.equal(without.failures.length, 1);
  assert.match(without.failures[0], /POST \/logs/);
});

test("nestjs: @UseGuards on the method protects it", () => {
  const guarded = run(
    {
      "src/logs.controller.ts":
        "@Controller('logs')\nexport class LogsController {\n  @UseGuards(AuthGuard)\n  @Post('/logs')\n  create() {}\n}\n",
    },
    authenticationFailures
  );
  assert.deepEqual(guarded.failures, []);

  const bare = run(
    {
      "src/logs.controller.ts":
        "@Controller('logs')\nexport class LogsController {\n  @Post('/logs')\n  create() {}\n}\n",
    },
    authenticationFailures
  );
  assert.equal(bare.failures.length, 1);
});

// ---------------------------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------------------------

test("go: an unprotected chi route fails", () => {
  const { failures } = run({ "main.go": 'r.Post("/logs", createLog)\n' }, authenticationFailures);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /POST \/logs/);
});

test("go: middleware in the chain counts, and Use() protects everything", () => {
  const perRoute = run({ "main.go": 'r.Post("/logs", RequireAuth(createLog))\n' }, authenticationFailures);
  assert.deepEqual(perRoute.failures, []);

  const global = run({ "main.go": 'r.Use(AuthMiddleware)\nr.Get("/logs", listLogs)\n' }, authenticationFailures);
  assert.deepEqual(global.failures, []);
});

// net/http's HandleFunc carries no method, and reporting a guessed one would be worse than none.
test("go: HandleFunc is reported as ANY rather than guessed", () => {
  const report = run({ "main.go": 'http.HandleFunc("/logs", handler)\n' }, checkAuthentication);
  assert.equal(report.routes.length, 1);
  assert.equal(report.routes[0].method, "ANY");
});

// ---------------------------------------------------------------------------------------------
// Java (Spring)
// ---------------------------------------------------------------------------------------------

test("java: a mapping without an authorization annotation fails", () => {
  const { failures } = run(
    {
      "src/LogController.java":
        '@RestController\npublic class LogController {\n  @PostMapping("/logs")\n  public void create() {}\n}\n',
    },
    authenticationFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /POST \/logs/);
});

test("java: @PreAuthorize counts, and a security filter chain protects everything", () => {
  const annotated = run(
    { "src/LogController.java": '@PostMapping("/logs")\n@PreAuthorize("hasRole(\'WRITER\')")\npublic void create() {}\n' },
    authenticationFailures
  );
  assert.deepEqual(annotated.failures, []);

  const chain = run(
    {
      "src/SecurityConfig.java": "http.authorizeHttpRequests(a -> a.anyRequest().authenticated());\n",
      "src/LogController.java": '@GetMapping("/logs")\npublic void list() {}\n',
    },
    authenticationFailures
  );
  assert.deepEqual(chain.failures, []);
});

// ---------------------------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------------------------

test("ruby: a Sinatra route without a before filter fails", () => {
  const { failures } = run({ "app.rb": "post '/logs' do\n  Log.create(params)\nend\n" }, authenticationFailures);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /POST \/logs/);
});

test("ruby: before_action :authenticate_user! protects the controller", () => {
  const { failures } = run(
    {
      "app.rb":
        "class LogsController\n  before_action :authenticate_user!\nend\n\nget '/logs' do\n  Log.all\nend\n",
    },
    authenticationFailures
  );
  assert.deepEqual(failures, []);
});

// Anchored to the start of a line so a method call inside a body is not read as a declaration.
test("ruby: a get call inside a body is not a route declaration", () => {
  const report = run(
    { "app.rb": "def fetch\n  response = client.get '/upstream' do |r|\n  end\nend\n" },
    checkAuthentication
  );
  assert.equal(report.routes.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------------------------

// Global auth is judged per language against that language's own files. A Python app-wide
// dependency says nothing about an Express server sitting beside it in the same repo.
test("one language's global auth does not protect another's routes", () => {
  const { failures } = run(
    {
      "api/main.py":
        "app = FastAPI(dependencies=[Depends(verify_api_key)])\n@app.get('/reports')\ndef read():\n    pass\n",
      "web/server.js": "app.post('/logs', create);\n",
    },
    authenticationFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /POST \/logs/);
  assert.doesNotMatch(failures[0], /\/reports/);
});

test("health probes are exempt in every language", () => {
  const { failures } = run(
    {
      "src/app.js": "app.get('/health', ok);\n",
      "main.go": 'r.Get("/healthz", ok)\n',
      "app.rb": "get '/ping' do\nend\n",
    },
    authenticationFailures
  );
  assert.deepEqual(failures, []);
});

// An endpoint whose job is to issue a credential cannot require one first.
test("credential-issuing endpoints are exempt, but paths beneath them are not", () => {
  const exempt = run({ "src/app.js": "app.post('/login', doLogin);\n" }, authenticationFailures);
  assert.deepEqual(exempt.failures, []);

  const notExempt = run({ "src/app.js": "app.get('/auth/admin/users', listUsers);\n" }, authenticationFailures);
  assert.equal(notExempt.failures.length, 1);
});

test("an unrecognised language is undetermined, not a pass", () => {
  const { failures, advisories } = run(
    { "src/main.php": "<?php Route::post('/logs', 'LogController@create');\n" },
    authenticationFailures
  );
  assert.deepEqual(failures, []);
  assert.equal(advisories.length, 1);
  assert.match(advisories[0], /not checked/);
});

test("the remediation names the idiom of the language actually found", () => {
  const { failures } = run({ "src/app.js": "app.post('/logs', create);\n" }, authenticationFailures);
  assert.match(failures[0], /app\.use\(requireAuth\)|preHandler|UseGuards/);
  assert.doesNotMatch(failures[0], /FastAPI/);
});

// Found by running this check over its own repository: 15 phantom routes came from this very test
// file, whose fixtures quote route calls as strings. A phantom route carries no middleware, so it
// reports as unprotected, so it would block a project that is in fact correct.
test("route calls quoted inside a test file are not routes", () => {
  const report = run(
    {
      "src/app.js": "app.post('/logs', requireAuth, create);\n",
      "src/app.test.js": "it('rejects anonymous writes', () => {\n  const src = \"app.post('/logs', create);\";\n});\n",
      "src/handlers.spec.ts": "describe('x', () => { const s = \"app.get('/admin', list);\"; });\n",
    },
    checkAuthentication
  );
  assert.equal(report.routes.length, 1, "only the real route in src/app.js should count");
  assert.equal(report.routes[0].file, "src/app.js");
});

test("test files in other languages are skipped too", () => {
  const report = run(
    {
      "main_test.go": 'r.Post("/logs", createLog)\n',
      "test_api.py": "@app.post('/logs')\ndef add():\n    pass\n",
      "app_spec.rb": "post '/logs' do\nend\n",
    },
    checkAuthentication
  );
  assert.equal(report.routes.length, 0);
  assert.ok(report.unknown, "nothing to check is undetermined, not a pass");
});

// The scanner's own remediation text describes a route shape. If that text were written as a
// quoted path followed by a comma, the check would declare a route every time it explained one.
test("the remediation text does not itself parse as a route", () => {
  const report = run(
    { "src/doc.js": "const help = \"middleware on the route (app.post(path, requireAuth, handler))\";\n" },
    checkAuthentication
  );
  assert.equal(report.routes.length, 0);
});

// A webhook sender proves identity by signing the payload, not by presenting a bearer token. This
// check reported such an endpoint as unauthenticated on a real webhook receiver -- a false
// positive only a different task shape would surface, since every earlier run used API keys.
test("a verified request signature is authentication", () => {
  const { failures } = run(
    {
      "src/main.py":
        "import hmac, hashlib\n" +
        "def verify(body, sig):\n" +
        "    expected = hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()\n" +
        "    return hmac.compare_digest(expected, sig)\n\n" +
        "@app.post('/webhook')\n" +
        "async def receive(request: Request, x_signature: str = Header(None)):\n" +
        "    pass\n",
    },
    authenticationFailures
  );
  assert.deepEqual(failures, []);
});

// The same discipline that keeps Depends(get_db) from counting: a header is not a control until
// something checks it.
test("a signature header with no verification anywhere is not authentication", () => {
  const { failures } = run(
    {
      "src/main.py":
        "@app.post('/webhook')\nasync def receive(x_signature: str = Header(None)):\n    return {'ok': True}\n",
    },
    authenticationFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /POST \/webhook/);
});

// Recognising a signature as authentication without this would leave the gate certifying a
// control with an exploitable timing leak, which is worse than not recognising it at all.
test("an equality-compared signature is reported even when every route is protected", () => {
  const leaky = {
    "src/main.py":
      "import hmac, hashlib\n" +
      "def verify(body, sig):\n" +
      "    expected_signature = hmac.new(S.encode(), body, hashlib.sha256).hexdigest()\n" +
      "    return expected_signature == sig\n\n" +
      "@app.post('/webhook')\n" +
      "async def receive(request: Request, x_signature: str = Header(None)):\n    pass\n",
  };
  const r = run(leaky, authenticationFailures);
  assert.equal(r.failures.length, 1, "no route is open, so this is the timing finding alone");
  assert.match(r.failures[0], /constant-time/);

  const fixed = {
    "src/main.py": leaky["src/main.py"].replace(
      "return expected_signature == sig",
      "return hmac.compare_digest(expected_signature, sig)"
    ),
  };
  assert.deepEqual(run(fixed, authenticationFailures).failures, [], "clears once compared safely");
});

// Found by hand-testing a webhook receiver that authenticated both routes, passed this gate, and
// still served every stored callback to an unauthenticated request: its Deployment never set
// SUPPORT_API_KEY, and `None != None` is false. The same file validated three other environment
// variables at startup and not these two.
test("a credential compared against an unset environment variable is a vacuous check", () => {
  const { failures } = run(
    {
      "src/main.py":
        "import os\n" +
        'SUPPORT_API_KEY = os.getenv("SUPPORT_API_KEY")\n\n' +
        "def verify(x_support_key: str = Header(None)):\n" +
        "    if x_support_key != SUPPORT_API_KEY:\n" +
        "        raise HTTPException(403)\n\n" +
        "@app.get('/lookup')\n" +
        "async def lookup(_ = Depends(verify)):\n    pass\n",
    },
    authenticationFailures
  );
  const v = vacuous(failures);
  assert.equal(v.length, 1, "the route is protected, so the vacuous finding stands alone");
  assert.match(v[0], /SUPPORT_API_KEY/);
  assert.match(v[0], /does not fail closed/);
});

test("a credential validated at startup is not vacuous", () => {
  for (const guard of [
    'if not SUPPORT_API_KEY:\n    raise RuntimeError("required")\n',
    "if SUPPORT_API_KEY is None:\n    raise RuntimeError()\n",
  ]) {
    const { failures } = run(
      {
        "src/main.py":
          "import os\n" +
          'SUPPORT_API_KEY = os.getenv("SUPPORT_API_KEY")\n' +
          guard +
          "\ndef verify(x_support_key: str = Header(None)):\n" +
          "    if x_support_key != SUPPORT_API_KEY:\n        raise HTTPException(403)\n\n" +
          "@app.get('/lookup')\nasync def lookup(_ = Depends(verify)):\n    pass\n",
      },
      authenticationFailures
    );
    assert.deepEqual(vacuous(failures), [], guard.split("\n")[0]);
  }
});

// os.environ[...] raises on a missing key, so it cannot be vacuous.
test("a credential read with os.environ[] is not vacuous", () => {
  const { failures } = run(
    {
      "src/main.py":
        "import os\n" +
        'SUPPORT_API_KEY = os.environ["SUPPORT_API_KEY"]\n\n' +
        "def verify(x_support_key: str = Header(None)):\n" +
        "    if x_support_key != SUPPORT_API_KEY:\n        raise HTTPException(403)\n\n" +
        "@app.get('/lookup')\nasync def lookup(_ = Depends(verify)):\n    pass\n",
    },
    authenticationFailures
  );
  assert.deepEqual(vacuous(failures), []);
});

// TypeScript, from a real run. The Python adapter learned about request signatures after a webhook
// receiver was wrongly reported open; this adapter did not, so the next receiver -- same task, same
// defect class, different language -- was wrongly reported open too.
test("an Express route whose handler verifies a signature is authenticated", () => {
  const { failures } = run(
    {
      "src/index.ts":
        "import { handleWebhook } from './handlers/webhook';\n" +
        "app.post('/webhook', express.raw({ type: 'application/json' }), handleWebhook);\n",
      "src/handlers/webhook.ts":
        "import crypto from 'crypto';\n" +
        "export const handleWebhook = async (req, res) => {\n" +
        "  const digest = crypto.createHmac('sha256', secret).update(req.body).digest('hex');\n" +
        "  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig))) return res.status(401).send();\n" +
        "  return res.status(200).send();\n};\n",
    },
    authenticationFailures
  );
  assert.deepEqual(failures, []);
});

// The corpus handed to an adapter is every file in that language concatenated. Reading a fixed
// window from a handler therefore runs past its end into the next file: an earlier attempt read
// 2500 characters from an unauthenticated handler, reached another route's signature code, and
// called the unauthenticated one verified. Worse than the miss it replaced.
test("signature verification in one handler does not protect another", () => {
  const { failures } = run(
    {
      "src/index.ts":
        "import { handleWebhook } from './handlers/webhook';\n" +
        "import { lookup } from './handlers/lookup';\n" +
        "app.post('/webhook', express.raw({ type: 'application/json' }), handleWebhook);\n" +
        "app.get('/lookup/:id', lookup);\n",
      "src/handlers/webhook.ts":
        "import crypto from 'crypto';\n" +
        "export const handleWebhook = async (req, res) => {\n" +
        "  const d = crypto.createHmac('sha256', s).update(req.body).digest('hex');\n" +
        "  return res.status(200).send();\n};\n",
      "src/handlers/lookup.ts":
        "export const lookup = async (req, res) => {\n  return res.status(200).json({});\n};\n",
    },
    authenticationFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /GET \/lookup/);
  assert.doesNotMatch(failures[0], /POST \/webhook/);
});

// process.env.X is undefined when unset and `undefined !== undefined` is false, exactly as in
// Python. The comparison is against the local the value was assigned to, not the env expression,
// which is why matching only on the env name found nothing in a deliverable that had the defect.
test("a TypeScript credential compared against an unset env var is vacuous", () => {
  const { failures } = run(
    {
      "src/index.ts": "app.get('/lookup/:id', requireSupportAuth, lookup);\n",
      "src/middleware.ts":
        "export const requireSupportAuth = (req, res, next) => {\n" +
        "  const supportKey = req.headers['x-support-key'];\n" +
        "  const expectedSupportKey = process.env.SUPPORT_TEAM_KEY;\n" +
        "  if (supportKey !== expectedSupportKey) return res.status(403).send();\n" +
        "  next();\n};\n",
    },
    authenticationFailures
  );
  assert.ok(failures.some((f) => /SUPPORT_TEAM_KEY/.test(f) && /does not fail closed/.test(f)));
});

test("a TypeScript credential guarded before comparison is not vacuous", () => {
  const { failures } = run(
    {
      "src/index.ts": "app.get('/lookup/:id', requireSupportAuth, lookup);\n",
      "src/middleware.ts":
        "export const requireSupportAuth = (req, res, next) => {\n" +
        "  const supportKey = req.headers['x-support-key'];\n" +
        "  const expectedKey = process.env.SUPPORT_TEAM_KEY;\n" +
        "  if (!expectedKey || !supportKey) return res.status(403).send();\n" +
        "  if (supportKey !== expectedKey) return res.status(403).send();\n" +
        "  next();\n};\n",
    },
    authenticationFailures
  );
  assert.deepEqual(failures, []);
});

// --- inline arrow handlers ---------------------------------------------------------------------
// Handler resolution originally worked by identifier, on the assumption that "Express handlers are
// named imports". An inline arrow has no identifier, so identical guarded logic was judged
// differently depending purely on handler shape. The three tests below are the probe that found it:
// the middle one is what proves the check is still live in that shape rather than dead.

const SIG_HELPERS =
  'import crypto from "crypto";\n' +
  'const SECRET = process.env.WEBHOOK_SECRET;\n' +
  "function verifySignature(raw, sig) {\n" +
  '  const mac = crypto.createHmac("sha256", SECRET).update(raw).digest();\n' +
  '  return crypto.timingSafeEqual(mac, Buffer.from(sig, "hex"));\n' +
  "}\n";

const GUARD =
  '  if (!verifySignature(req.rawBody, req.headers["x-signature"])) return res.status(401).end();\n';

test("named middleware with a signature guard is clean", () => {
  const { failures } = run(
    {
      "server.js":
        SIG_HELPERS +
        "function handleWebhook(req, res) {\n" + GUARD + "  res.json({ ok: true });\n}\n" +
        'app.post("/webhook", express.raw({ type: "*/*" }), handleWebhook);\n',
    },
    authenticationFailures
  );
  assert.deepEqual(failures, []);
});

test("named middleware with the guard removed still flags (the check is live in this shape)", () => {
  const { failures } = run(
    {
      "server.js":
        SIG_HELPERS +
        "function handleWebhook(req, res) {\n  res.json({ ok: true });\n}\n" +
        'app.post("/webhook", express.raw({ type: "*/*" }), handleWebhook);\n',
    },
    authenticationFailures
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /POST \/webhook/);
});

test("an inline arrow handler with the same guard is clean", () => {
  const { routes } = run(
    {
      "server.js":
        SIG_HELPERS +
        'app.post("/webhook", express.raw({ type: "*/*" }), (req, res) => {\n' +
        GUARD +
        "  res.json({ ok: true });\n});\n",
    },
    checkAuthentication
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0].protectedBy, "a verified request signature");
});

// Reading an inline body must not credit the NEXT route with it. A fixed-size window did exactly
// that once, reporting an unauthenticated endpoint as verified using another route's code — worse
// than the false positive it replaced, so both orderings are pinned here.
test("an inline body does not protect a following unguarded route", () => {
  const { routes, failures } = run(
    {
      "server.js":
        SIG_HELPERS +
        'app.post("/webhook", express.raw({ type: "*/*" }), (req, res) => {\n' +
        GUARD +
        "  res.json({ ok: true });\n});\n" +
        'app.get("/lookup/:id", (req, res) => {\n  res.json({ event: store.get(req.params.id) });\n});\n',
      "x.js": "",
    },
    (d) => ({ ...checkAuthentication(d), ...authenticationFailures(d) })
  );
  assert.equal(routes.find((r) => r.route === "/webhook").protectedBy, "a verified request signature");
  assert.equal(routes.find((r) => r.route === "/lookup/:id").protectedBy, null);
  assert.equal(failures.length, 1);
});

test("an unguarded inline route does not borrow a named handler defined after it", () => {
  const { routes } = run(
    {
      "server.js":
        SIG_HELPERS +
        'app.get("/lookup/:id", (req, res) => {\n  res.json({ event: store.get(req.params.id) });\n});\n' +
        "function handleWebhook(req, res) {\n" + GUARD + "  res.json({ ok: true });\n}\n" +
        'app.post("/webhook", express.raw({ type: "*/*" }), handleWebhook);\n',
    },
    checkAuthentication
  );
  assert.equal(routes.find((r) => r.route === "/lookup/:id").protectedBy, null);
  assert.equal(routes.find((r) => r.route === "/webhook").protectedBy, "a verified request signature");
});

// Express's chained form has the same shape gap, and worse: JS_CHAIN_VERB_RE's `[^)]*` argument
// capture stops at the first `)`, which an inline arrow's own parameter list supplies — so its
// `context` is the useless fragment "(req, res" and cannot see a guard at all.
test("a chained .route().post() with an inline guard is clean", () => {
  const { routes } = run(
    {
      "server.js":
        SIG_HELPERS +
        'app.route("/webhook").post((req, res) => {\n' + GUARD + "  res.json({ ok: true });\n});\n",
    },
    checkAuthentication
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0].protectedBy, "a verified request signature");
});

test("a chained .route().get() with no guard still flags", () => {
  const { routes } = run(
    {
      "server.js":
        SIG_HELPERS +
        'app.route("/lookup").get((req, res) => {\n  res.json({ event: store.get(req.query.id) });\n});\n',
    },
    checkAuthentication
  );
  assert.equal(routes[0].protectedBy, null);
});

// --- python credential headers ------------------------------------------------------------------
// The name list was fixed at six spellings, so a real support endpoint guarded by
// `x_internal_token` was reported as open to anyone. Found while grading webhook-5: the endpoint
// rejected every caller, and the gate called it unauthenticated.

test("a credential header the list never enumerated still counts", () => {
  const { routes } = run(
    {
      "app/main.py":
        "@app.get('/support/callbacks/{event_id}')\n" +
        "async def get_callback(event_id: str, x_internal_token: str = Header(None)):\n" +
        "    if x_internal_token != internal_token:\n" +
        "        raise HTTPException(status_code=403, detail='Unauthorized')\n" +
        "    return {}\n",
    },
    checkAuthentication
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0].protectedBy, "a credential header");
});

// The corroboration that makes widening the names safe. Declaring a credential parameter is not
// checking it, and a gate that invents protection is worse than one that misses it.
test("a credential header the handler never checks does NOT count", () => {
  const { routes } = run(
    {
      "app/main.py":
        "@app.get('/logs')\n" +
        "def read(x_internal_token: str = Header(None)):\n" +
        "    return db.all()\n",
    },
    checkAuthentication
  );
  assert.equal(routes[0].protectedBy, null);
});

test("a signature header is not credited as a plain credential", () => {
  const { routes } = run(
    {
      "app/main.py":
        "@app.post('/webhook')\n" +
        "async def hook(x_provider_signature: str = Header(None)):\n" +
        "    if not x_provider_signature:\n        raise HTTPException(status_code=401)\n" +
        "    return {}\n",
    },
    checkAuthentication
  );
  // Nothing in this project verifies a signature, so naming the header must not protect the route.
  assert.equal(routes[0].protectedBy, null);
});

// --- timing-unsafe comparison of a non-signature credential --------------------------------------
// A support token is a better timing target than a signature: it is stable across attempts, so one
// recovered value keeps working, and the caller may retry freely.

test("a bearer credential compared with != is reported", () => {
  const { failures } = run(
    {
      "app/main.py":
        "@app.get('/support/{id}')\n" +
        "async def get(id: str, x_internal_token: str = Header(None)):\n" +
        "    if x_internal_token != internal_token:\n" +
        "        raise HTTPException(status_code=403)\n    return {}\n",
    },
    authenticationFailures
  );
  const timing = failures.filter((f) => /constant-time/.test(f));
  assert.equal(timing.length, 1);
  assert.match(timing[0], /x_internal_token/);
  assert.match(timing[0], /stable across attempts/);
});

// The bug this check shipped with for one revision: gating on "does the file compare anything in
// constant time" let a correct signature comparison suppress the report of an incorrect token one.
// webhook-5 had exactly that pair.
test("a correct signature comparison does not suppress an incorrect token comparison", () => {
  const { failures } = run(
    {
      "app/main.py":
        "def verify_signature(payload, signature):\n" +
        "    expected = hmac.new(k, payload, hashlib.sha256).hexdigest()\n" +
        "    return hmac.compare_digest(expected, signature)\n\n" +
        "@app.get('/support/{id}')\n" +
        "async def get(id: str, x_internal_token: str = Header(None)):\n" +
        "    if x_internal_token != internal_token:\n" +
        "        raise HTTPException(status_code=403)\n    return {}\n",
    },
    authenticationFailures
  );
  assert.equal(failures.filter((f) => /constant-time/.test(f)).length, 1);
});

test("a credential compared in constant time is clean", () => {
  const { failures } = run(
    {
      "app/main.py":
        "@app.get('/support/{id}')\n" +
        "async def get(id: str, x_internal_token: str = Header(None)):\n" +
        "    if not hmac.compare_digest(x_internal_token, internal_token):\n" +
        "        raise HTTPException(status_code=403)\n    return {}\n",
    },
    authenticationFailures
  );
  assert.deepEqual(failures.filter((f) => /constant-time/.test(f)), []);
});

// One defect must not be reported under two names.
test("a loosely compared signature is the signature finding, not the credential one", () => {
  const { failures } = run(
    {
      "app/main.py":
        "@app.post('/webhook')\n" +
        "async def hook(x_signature: str = Header(None)):\n" +
        "    expected = hmac.new(k, body, hashlib.sha256).hexdigest()\n" +
        "    if expected != x_signature:\n" +
        "        raise HTTPException(status_code=401)\n    return {}\n",
    },
    authenticationFailures
  );
  const timing = failures.filter((f) => /constant-time/.test(f));
  assert.equal(timing.length, 1);
  assert.match(timing[0], /request signature/);
});
