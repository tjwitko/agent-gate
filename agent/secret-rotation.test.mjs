import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { taskRequiresRotation, secretRotationFailures, checkSecretRotation } from "./secret-rotation.mjs";

function run(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "rot-"));
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

const ROTATES = "The provider rotates its signing secret every quarter.";
const NO_ROTATION = "Accept callbacks and store them.";

const CACHED_FOREVER =
  "secrets_cache = {}\n" +
  "def get_signing_secret():\n" +
  '    if "SIGNING_SECRET" not in secrets_cache:\n' +
  "        response = secrets_client.get_secret_value(SecretId=SECRET_ID)\n" +
  '        secrets_cache["SIGNING_SECRET"] = json.loads(response["SecretString"])\n' +
  '    return secrets_cache["SIGNING_SECRET"]\n';

test("taskRequiresRotation reads the requirement, and does not invent it", () => {
  assert.equal(taskRequiresRotation(ROTATES), true);
  assert.equal(taskRequiresRotation(NO_ROTATION), false);
  assert.equal(taskRequiresRotation("We rotate the on-call engineer weekly."), false);
});

test("a secret cached with no expiry fails when the task says it rotates", () => {
  const { failures } = run({ "app/main.py": CACHED_FOREVER }, (d) => secretRotationFailures(d, ROTATES));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /fetched once and cached/);
  assert.match(failures[0], /retired secret keeps being accepted/);
});

test("the same code is advisory when nothing in the task rotates", () => {
  const { failures, advisories } = run({ "app/main.py": CACHED_FOREVER }, (d) =>
    secretRotationFailures(d, NO_ROTATION)
  );
  assert.deepEqual(failures, []);
  assert.equal(advisories.length, 1);
});

// The false positive this check shipped with for one revision. get_secret() here is an ordinary
// helper that fetches fresh every call -- the shape that rotates CORRECTLY -- and an unrelated
// `if not x_provider_signature:` guard sat above the call site.
test("a fresh fetch on every request is clean, even under a nearby guard clause", () => {
  const src =
    "def get_secret():\n" +
    "    response = secrets_client.get_secret_value(SecretId=SECRET_ID)\n" +
    '    return json.loads(response["SecretString"])["secret_key"]\n\n' +
    "@app.post('/webhook')\n" +
    "async def hook(request: Request, x_provider_signature: str = Header(None)):\n" +
    "    if not x_provider_signature:\n" +
    "        raise HTTPException(status_code=400)\n" +
    "    secret_key = get_secret()\n" +
    "    return {}\n";
  const { failures } = run({ "app/main.py": src }, (d) => secretRotationFailures(d, ROTATES));
  assert.deepEqual(failures, []);
});

test("a TTL on the cache is clean", () => {
  const src =
    "let cachedSecrets = [];\nlet lastFetchTime = 0;\nconst CACHE_TTL = 5 * 60 * 1000;\n" +
    "export async function getSecrets() {\n" +
    "  const now = Date.now();\n" +
    "  if (cachedSecrets.length > 0 && now - lastFetchTime < CACHE_TTL) return cachedSecrets;\n" +
    "  const res = await client.send(new GetSecretValueCommand({ SecretId: id }));\n" +
    "  cachedSecrets = JSON.parse(res.SecretString).secrets;\n" +
    "  return cachedSecrets;\n}\n";
  const { failures } = run({ "src/secrets.ts": src }, (d) => secretRotationFailures(d, ROTATES));
  assert.deepEqual(failures, []);
});

test("an lru_cache on the fetch is caught even with no container to name", () => {
  const src =
    "@lru_cache(maxsize=1)\n" +
    "def signing_secret():\n" +
    "    return secrets_client.get_secret_value(SecretId=SECRET_ID)\n";
  const { failures } = run({ "app/main.py": src }, (d) => secretRotationFailures(d, ROTATES));
  assert.equal(failures.length, 1);
});

// Silence must never read as success: a stated rotation requirement with no managed-store read at
// all is a different answer from "the caching is fine", and is reported as its own statement.
test("a rotation requirement with no secret-store read is reported, not passed", () => {
  const { failures, advisories } = run(
    { "app/main.py": 'SECRET = os.environ["SIGNING_SECRET"]\n' },
    (d) => secretRotationFailures(d, ROTATES)
  );
  assert.deepEqual(failures, []);
  assert.equal(advisories.length, 1);
  assert.match(advisories[0], /nothing here reads a secret from a managed store/);
});

test("no source files is reported as not-checked", () => {
  const { advisories } = run({ "README.md": "hi" }, (d) => secretRotationFailures(d, ROTATES));
  assert.match(advisories[0], /not checked/);
});
