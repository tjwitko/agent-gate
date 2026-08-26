import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { checkAuthentication, authenticationFailures } from "./authentication.mjs";

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

  const header = run(
    { "app/main.py": "@app.post('/logs')\ndef add(x_api_key: str = Header(...)):\n    pass\n" },
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
        "@app.post('/logs')\ndef add(x_api_key: str = Header(...)):\n    pass\n\n" +
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
