import test from "node:test";
import assert from "node:assert/strict";

import { taskMatcher } from "./task-phrases.mjs";

test("unambiguous alternatives match on their own", () => {
  const m = taskMatcher({ any: [/\bterraform\b/i, /\bIaC\b/] });
  assert.ok(m("Use Terraform for all infrastructure"));
  assert.ok(m("our standard IaC tooling"));
  assert.ok(!m("Deploy the service"));
});

test("a pair matches in either order", () => {
  const m = taskMatcher({ terms: [], near: [{ terms: "ships?|shipped", nouns: "containers?" }] });
  assert.ok(m("ship it as a container"));
  assert.ok(m("the container we shipped last week"));
});

// The trap this module exists to pay for once: with [^.]{0,N} a proximity span ran through a
// semicolon, and "deploys run every month; the api key lives in Secrets Manager" was read as a
// rotation requirement.
test("a proximity span stops at a semicolon, a newline and a full stop", () => {
  const m = taskMatcher({ near: [{ terms: "rotates?|rotated", nouns: "secrets?|keys?" }] });
  assert.ok(m("the provider rotates its signing key every quarter"));
  assert.ok(!m("deploys rotate every month; the api key lives in Secrets Manager"));
  assert.ok(!m("deploys rotate every month. The api key lives in Secrets Manager"));
  assert.ok(!m("deploys rotate every month\nthe api key lives in Secrets Manager"));
});

// /\bsigning\s+key\b/ does NOT match "signing keys": the \b lands between "key" and "s".
test("a noun list needs its own plural and gets it", () => {
  const m = taskMatcher({ near: [{ terms: "rotates?", nouns: "signing keys?" }] });
  assert.ok(m("the provider rotates its signing key"));
  assert.ok(m("the provider rotates its signing keys"));
});

// `roll\w*` also matches "rolling deployment", which is why ambiguous verbs are spelled out.
test("ambiguous terms are not stemmed into unrelated words", () => {
  const m = taskMatcher({ near: [{ terms: "rolls?|rolled", nouns: "secrets?|keys?" }] });
  assert.ok(m("the signing key is rolled every quarter"));
  assert.ok(!m("use a rolling deployment so the api key service stays up"));
});

test("the window is bounded, so a distant noun does not pair", () => {
  const m = taskMatcher({ near: [{ terms: "declares?", nouns: "infrastructure", window: 20 }] });
  assert.ok(m("declare the infrastructure"));
  assert.ok(!m("declare every one of the many things this service needs before infrastructure"));
});

test("an empty spec matches nothing, rather than everything", () => {
  const m = taskMatcher();
  assert.ok(!m("anything at all"));
  assert.ok(!m(""));
});

test("a missing task text is not a match", () => {
  const m = taskMatcher({ any: [/\bterraform\b/i] });
  assert.ok(!m());
});
