import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";

import { splitSentences, judgeSentences, unjudgedSentences, RECOGNISERS } from "./requirement-sentences.mjs";
import { taskRetentionRequirement } from "./retention.mjs";
import { taskRequiresRotation } from "./secret-rotation.mjs";
import { taskRequiresImmutability } from "./immutability.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const TASK_FILES = readdirSync(FIXTURES).filter((f) => /task.*\.txt$/.test(f));

// Re-wrap paragraph and list-item text at `width`, as an editor would: list markers kept,
// continuation lines indented under the item, headings and blank lines left alone.
function rewrap(text, width) {
  const out = [];
  let buf = null;
  const flush = () => {
    if (!buf) return;
    let line = buf.prefix;
    for (const w of buf.text.split(/\s+/)) {
      if (line.trim() && (line + w).length > width) { out.push(line.trimEnd()); line = " ".repeat(buf.prefix.length); }
      line += `${w} `;
    }
    out.push(line.trimEnd());
    buf = null;
  };
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t || (/[A-Z]/.test(t) && !/[a-z]/.test(t))) { flush(); out.push(t); continue; }
    const m = /^([-*]|\d+[.)])\s+(.*)$/.exec(t);
    if (m) { flush(); buf = { prefix: `${m[1]} `, text: m[2] }; }
    else if (buf) buf.text += ` ${t}`;
    else buf = { prefix: "", text: t };
  }
  flush();
  return out.join("\n");
}

// The rephrasings each predicate is tested with, read from those tests' own source so this test
// cannot drift from them. Every named list must be found and non-empty, or the invariant would
// quietly cover less.
function phraseLists() {
  const lists = {
    "code-quality.test.mjs": ["WANTS_TESTS", "WANTS_NO_TESTS", "WANTS_ERROR_DISTINCTION", "NO_ERROR_DISTINCTION"],
    "immutability.test.mjs": ["REQUIRES", "DOES_NOT_REQUIRE"],
    "retention.test.mjs": ["STATES_A_PERIOD", "STATES_NO_PERIOD"],
    "artifact-presence.test.mjs": ["REPHRASINGS", "NAMES_NO_ARTIFACT"],
  };
  const strings = (src) => [...src.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
  const out = {};
  for (const [file, names] of Object.entries(lists)) {
    const src = readFileSync(path.join(__dirname, file), "utf8");
    for (const name of names) {
      const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`).exec(src);
      assert.ok(m, `${file}: ${name} not found`);
      out[name] = strings(m[1]);
      assert.ok(out[name].length > 0, `${file}: ${name} is empty`);
    }
  }
  const rotation = readFileSync(path.join(__dirname, "secret-rotation.test.mjs"), "utf8");
  out.ROTATION = [...rotation.matchAll(/for \(const task of \[([\s\S]*?)\]\) \{/g)].flatMap((m) => strings(m[1]));
  assert.ok(out.ROTATION.length >= 15, `secret-rotation.test.mjs: ${out.ROTATION.length} rephrasings found`);
  return out;
}

/** Each check's answer on the whole text, and the answer its per-sentence results combine to. */
function compare(text) {
  const judged = judgeSentences(text);
  const diffs = [];
  for (const r of RECOGNISERS) {
    const whole = r.recognises(text);
    const combined = judged.some((s) => s.checks.includes(r.check));
    if (whole !== combined) diffs.push(`${r.check}: whole text ${whole}, sentences ${combined}`);
  }
  const days = taskRetentionRequirement(text)?.days ?? null;
  const first = judged.map((s) => taskRetentionRequirement(s.text)).find(Boolean)?.days ?? null;
  if (days !== first) diffs.push(`retention period: whole text ${days}, first sentence ${first}`);
  return diffs;
}

// --- the invariant ---------------------------------------------------------------------------
//
// The report names sentences no check read. It is only true if the checks read sentence by sentence
// too: if the whole text switched a check on that no single sentence did, the report would list as
// unread the very sentence that was read, and the other way round.

for (const f of TASK_FILES) {
  test(`${f}: each check's answer is its sentences' answers combined, at any wrap width`, () => {
    const text = readFileSync(path.join(FIXTURES, f), "utf8");
    for (const [label, t] of [["as written", text], ...[30, 40, 50, 60, 72, 80, 100].map((w) => [`wrapped at ${w}`, rewrap(text, w)])]) {
      assert.deepEqual(compare(t), [], `${f}, ${label}`);
    }
  });

  // Wrapping is presentation. Measured before sentences were shared: at 30 columns "- Records are
  // retained for / seven years" switched retention off for the webhook and Slack tasks.
  test(`${f}: re-wrapping does not change what any check reads`, () => {
    const text = readFileSync(path.join(FIXTURES, f), "utf8");
    const answers = (t) => RECOGNISERS.map((r) => r.recognises(t)).concat(taskRetentionRequirement(t)?.days ?? null);
    const reference = answers(text);
    for (const w of [30, 40, 50, 60, 72, 80, 100]) assert.deepEqual(answers(rewrap(text, w)), reference, `wrapped at ${w}`);
  });
}

test("every rephrasing the predicates are tested with: alone, and all of them as one document", () => {
  const lists = phraseLists();
  const all = Object.values(lists).flat();
  for (const phrase of all) assert.deepEqual(compare(phrase), [], phrase);
  // One document, each phrase its own paragraph, so no check can combine two of them into a
  // requirement neither states.
  assert.deepEqual(compare(all.join("\n\n")), []);
  assert.ok(all.length >= 60, `${all.length} phrases`);
});

// --- what crossing a sentence used to invent ------------------------------------------------------

test("a rotation word and a secret in different sentences state no rotation", () => {
  // Each half is one of secret-rotation's own negative cases. Side by side, the whole-text
  // conjunction read them as a rotation requirement, and a correctly cached secret would block.
  assert.equal(taskRequiresRotation("We rotate the on-call engineer weekly. Store the API key in Secrets Manager."), false);
  assert.equal(taskRequiresRotation("Rotate the logs daily. The API key is kept in Secrets Manager."), false);
});

test("a rotation stated through a pronoun is not read -- and is reported as not read", () => {
  // The cost of scoping rotation to a sentence, made visible rather than silent.
  const text = "The signing secret is kept in Secrets Manager. It must be rotated every 90 days.";
  assert.equal(taskRequiresRotation(text), false);
  assert.deepEqual(unjudgedSentences(text).map((s) => s.text), [
    "The signing secret is kept in Secrets Manager.",
    "It must be rotated every 90 days.",
  ]);
});

// --- the split -----------------------------------------------------------------------------------

test("a list item continues on its indented lines, and a sentence reports the line it starts on", () => {
  const s = splitSentences("REQUIREMENTS\n- Records are retained for\n  seven years. Nothing is deleted.\n- Tests run in CI.\n");
  assert.deepEqual(s, [
    { text: "REQUIREMENTS", line: 1, heading: true },
    { text: "Records are retained for seven years.", line: 2, heading: false },
    { text: "Nothing is deleted.", line: 3, heading: false },
    { text: "Tests run in CI.", line: 4, heading: false },
  ]);
  assert.equal(taskRetentionRequirement("- Records are retained for\n  seven years.")?.days, 2555);
});

test("any other line break still ends a thought", () => {
  // task-phrases.mjs trap 1. Joining these invented an immutability requirement.
  assert.equal(taskRequiresImmutability("The queue must not back up\nworkers delete messages after processing."), false);
});

test("e.g. and a version number do not end a sentence", () => {
  assert.deepEqual(splitSentences("Use a managed store, e.g. Secrets Manager v1.2 or later.").map((s) => s.text),
    ["Use a managed store, e.g. Secrets Manager v1.2 or later."]);
});

test("headings are read by the checks but never reported as unread", () => {
  const text = "DEPLOYMENT\nTERRAFORM\n- AWS, single region.\n";
  assert.ok(judgeSentences(text).find((s) => s.text === "TERRAFORM").checks.includes("artifact_presence (terraform)"));
  assert.deepEqual(unjudgedSentences(text), [{ line: 3, text: "AWS, single region." }]);
});

test("the webhook task: the sentences no check reads are the ones no check could", () => {
  const text = readFileSync(path.join(FIXTURES, "webhook-receiver-task.txt"), "utf8");
  assert.deepEqual(unjudgedSentences(text).map((s) => s.line), [1, 4, 5, 6, 8, 9, 14, 14, 27]);
  assert.match(unjudgedSentences(text)[3].text, /^Keep every callback received, so that a chargeback dispute raised weeks later can be settled/);
});

// --- the report, from the real CLI ------------------------------------------------------------

test("baseline sentences no check read are printed above the verdict; task sentences are counted", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "reqsent-"));
  try {
    mkdirSync(path.join(dir, "proj"));
    writeFileSync(path.join(dir, "proj", "app.py"), "def handler(event):\n    return event\n");
    writeFileSync(path.join(dir, "task.txt"), "Build a small service.\n- Ship tests someone else can run.\n");
    writeFileSync(path.join(dir, "baseline.txt"), "The webhook signing secret must be rotated every 90 days.\nAll endpoints must log the caller.\n");
    const cli = path.resolve(__dirname, "..", "bin", "validate.mjs");
    const args = [cli, path.join(dir, "proj"), path.join(dir, "task.txt"), `--baseline=${path.join(dir, "baseline.txt")}`];

    const human = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 300_000 }).stdout;
    assert.match(human, /^task sentences : 2, 1 read by a check, 1 by none \(--json lists them\)$/m);
    const banner = human.indexOf("!! 1 BASELINE SENTENCE(S) NO CHECK READ");
    assert.ok(banner > 0, human);
    assert.ok(banner < human.indexOf("\nBLOCKING"), "above the verdict");
    assert.match(human, /^ {3}- line 2: All endpoints must log the caller\.$/m);
    assert.doesNotMatch(human, /line 1: The webhook signing secret/, "the rotation sentence was read");

    const doc = JSON.parse(spawnSync(process.execPath, [...args, "--json"], { encoding: "utf8", timeout: 300_000 }).stdout);
    assert.deepEqual(doc.requirementsRead.task, { sentences: 2, read: 1, unread: [{ line: 1, text: "Build a small service." }] });
    assert.deepEqual(doc.requirementsRead.baseline.unread, [{ line: 2, text: "All endpoints must log the caller." }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
