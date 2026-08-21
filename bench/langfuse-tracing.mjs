// Langfuse tracing for the benchmark harness.
//
// Design constraint that shapes everything here: **tracing must never be able to fail a
// benchmark**. A benchmark run costs minutes of wall-clock and real model time; losing one
// because an observability sidecar was down would be a bad trade. So every export path is
// best-effort, and if Langfuse is unreachable the harness runs exactly as it did before this
// file existed — same stdout, same bench-report.json, same exit code.
//
// Deliberately instruments the *harness*, not index.mjs. The server sanitizes process.env down to
// a five-key allowlist (see sanitizeEnv there), so tracing inside it would mean widening that
// allowlist to carry LANGFUSE_* credentials into a process whose whole point is a minimal
// environment. The harness already parses the server's `[usage]` stderr line and owns all the
// timing, so it can emit a complete generation observation without the server knowing Langfuse
// exists at all.

import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The sibling stack in ../../langfuse-local writes its keys to a gitignored .env. Reading it
// directly means `./langfuse.sh up` then `node run-benchmark.mjs` just works, with no export step.
const DEFAULT_ENV_FILE = path.resolve(__dirname, "..", "..", "langfuse-local", ".env");

function loadEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

/**
 * Resolve credentials once, in one place, so the experiment runner and the tracing pipeline can
 * never disagree about which Langfuse they are talking to.
 */
export function getLangfuseConfig() {
  return resolveConfig();
}

function resolveConfig() {
  const fromFile = loadEnvFile(process.env.LANGFUSE_ENV_FILE || DEFAULT_ENV_FILE);
  // Real environment wins over the file, so a one-off run can point somewhere else.
  const pick = (k) => process.env[k] || fromFile[k];
  return {
    publicKey: pick("LANGFUSE_PUBLIC_KEY"),
    secretKey: pick("LANGFUSE_SECRET_KEY"),
    // The SDK reads both spellings depending on code path; resolve it here and pass explicitly.
    baseUrl: pick("LANGFUSE_BASE_URL") || pick("LANGFUSE_BASEURL") || "http://localhost:3000",
  };
}

// Defense in depth. Traces never leave localhost, but benchmark prompts carry whole source files
// and a task JSON is easy to edit carelessly. Masking obvious credential shapes on the way out
// costs nothing and means a slip never lands in the trace store.
const SECRET_PATTERNS = [
  /\b(sk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:AIza)[0-9A-Za-z_-]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
];

function maskSecrets({ data }) {
  if (typeof data === "string") {
    let out = data;
    for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
    return out;
  }
  if (data && typeof data === "object") {
    try {
      let json = JSON.stringify(data);
      for (const re of SECRET_PATTERNS) json = json.replace(re, "[REDACTED]");
      return JSON.parse(json);
    } catch {
      return data;
    }
  }
  return data;
}

// A stand-in with the same surface as a LangfuseSpan, so instrumented call sites need no
// conditionals — they call the same methods whether tracing is on or off.
const NOOP_OBSERVATION = {
  update() { return this; },
  end() { return this; },
  startObservation() { return NOOP_OBSERVATION; },
  score() { return this; },
};

let state = { enabled: false, sdk: null, processor: null, tracing: null, client: null };

async function serverReachable(baseUrl) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(new URL("/api/public/health", baseUrl), { signal: ctl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start tracing if it is both configured and actually usable. Probing health up front matters:
 * without it the OTel processor happily buffers spans for a server that will never answer, and
 * the run ends with a silent flush timeout instead of an honest "tracing is off" line.
 *
 * @returns {Promise<boolean>} whether tracing is live
 */
export async function initTracing({ quiet = false } = {}) {
  const cfg = resolveConfig();
  const note = (msg) => { if (!quiet) console.log(`==> [langfuse] ${msg}`); };

  if (!cfg.publicKey || !cfg.secretKey) {
    note("no API keys found, tracing disabled (start the stack: ../langfuse-local/langfuse.sh up)");
    return false;
  }
  if (!(await serverReachable(cfg.baseUrl))) {
    note(`${cfg.baseUrl} unreachable, tracing disabled for this run`);
    return false;
  }

  try {
    const [{ NodeSDK }, { LangfuseSpanProcessor }, tracing, { LangfuseClient }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@langfuse/otel"),
      import("@langfuse/tracing"),
      import("@langfuse/client"),
    ]);

    const processor = new LangfuseSpanProcessor({
      publicKey: cfg.publicKey,
      secretKey: cfg.secretKey,
      baseUrl: cfg.baseUrl,
      mask: maskSecrets,
      // A benchmark is a handful of long spans, not high-volume traffic. Flushing eagerly means
      // a run that dies mid-way still leaves its completed attempts in the UI.
      flushAt: 1,
      flushInterval: 1,
    });

    const sdk = new NodeSDK({ spanProcessors: [processor] });
    sdk.start();

    // Scores travel over the REST API rather than the OTel pipeline, so they need their own
    // client — same credentials, separate flush.
    const client = new LangfuseClient({
      publicKey: cfg.publicKey,
      secretKey: cfg.secretKey,
      baseUrl: cfg.baseUrl,
    });

    state = { enabled: true, sdk, processor, tracing, client };
    note(`tracing to ${cfg.baseUrl}`);
    return true;
  } catch (err) {
    note(`failed to initialize (${err.message}), continuing without tracing`);
    state = { enabled: false, sdk: null, processor: null, tracing: null, client: null };
    return false;
  }
}

export function tracingEnabled() {
  return state.enabled;
}

/**
 * Open the root observation for one benchmark run. Returns a no-op with the same shape when
 * tracing is off, so callers never branch.
 */
export function startRun(name, attributes = {}) {
  if (!state.enabled) return NOOP_OBSERVATION;
  try {
    return state.tracing.startObservation(name, attributes);
  } catch {
    return NOOP_OBSERVATION;
  }
}

/**
 * Open a generation for one delegate call, BEFORE the call is made.
 *
 * The ordering is the point. An observation's duration is measured from when it is created, so
 * building it after the call returns records a 0s generation — which silently discards per-attempt
 * wall-clock, one of the three numbers this benchmark exists to compare. Opening it first also
 * means an attempt that never returns still appears in the UI as an in-flight span rather than
 * vanishing.
 */
export function startAttempt(parent, { name, model, modelParameters, input }) {
  if (!state.enabled || parent === NOOP_OBSERVATION) return NOOP_OBSERVATION;
  try {
    return parent.startObservation(name, { model, modelParameters, input }, { asType: "generation" });
  } catch {
    return NOOP_OBSERVATION;
  }
}

/**
 * Close a generation opened by startAttempt. `usage` is the parsed `[usage]` line from the
 * server's stderr — absent on failed attempts, which is itself worth seeing, so a missing usage
 * object is recorded rather than skipped.
 */
export function finishAttempt(gen, { output, usage, level, statusMessage, metadata } = {}) {
  if (!gen || gen === NOOP_OBSERVATION) return;
  try {
    const update = { output, metadata };
    if (usage) {
      update.usageDetails = {
        input: usage.prompt_tokens ?? 0,
        output: usage.completion_tokens ?? 0,
        total: usage.total_tokens ?? 0,
      };
    }
    if (level) update.level = level;
    if (statusMessage) update.statusMessage = statusMessage;
    gen.update(update).end();
  } catch {
    // Never let an observability failure surface as a benchmark failure.
  }
}

/** A plain child span, for the non-model phases (file splitting, dep check, verification). */
export function startStep(parent, name, attributes = {}) {
  if (!state.enabled || parent === NOOP_OBSERVATION) return NOOP_OBSERVATION;
  try {
    return parent.startObservation(name, attributes);
  } catch {
    return NOOP_OBSERVATION;
  }
}

/**
 * Attach a score to a run. Numeric scores are what make two benchmark runs comparable in the UI:
 * Langfuse charts them over time, so "did the 9B ever beat the 7B on attempts?" becomes a
 * question you answer by looking rather than by diffing JSON files by hand.
 */
export function scoreRun(observation, { name, value, comment }) {
  if (!state.enabled || observation === NOOP_OBSERVATION || !observation?.otelSpan) return;
  try {
    state.client.score.observation({ otelSpan: observation.otelSpan }, { name, value, comment });
  } catch {
    // Scores are the least important artifact here; never let one break a run.
  }
}

/**
 * Flush and shut down. Bounded, because an unreachable-mid-run server must not turn into a
 * hung benchmark process — the numbers are already on disk by the time this is called.
 */
export async function shutdownTracing({ timeoutMs = 10_000 } = {}) {
  if (!state.enabled) return;
  const { sdk, processor, client } = state;
  state = { enabled: false, sdk: null, processor: null, tracing: null, client: null };
  try {
    await Promise.race([
      (async () => {
        await processor.forceFlush();
        await sdk.shutdown();
        await client.shutdown();
      })(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // Nothing actionable: the run's real output is bench-report.json, which is already written.
  }
}
