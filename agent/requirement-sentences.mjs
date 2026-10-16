// Which sentences of the requirements any check read, and which none did.
//
// Six checks are gated on the task text, and each asks one yes/no question of the whole of it:
// does it want tests, does it state a retention period, does it say a secret rotates. A yes switches
// a check on and a no switches it off, and a no is silent -- a gated-off check reports "not
// checked", which reads as unremarkable rather than as a requirement nobody looked at. That is how
// "Both Slack tokens must be rotatable" left secret_rotation off for two graded runs: the word was
// not in its list, and nothing said that the sentence had been read by nothing.
//
// So the text is split into sentences and every check's recogniser is run on each one. A sentence
// that no recogniser takes is a requirement the gate does not hold the project to. It may be one no
// check could hold it to ("accept callbacks at a public endpoint"), or one a check should have
// recognised and did not; either way the reader is told, rather than left to infer it from a
// "not checked" line.
//
// The split has to agree with the checks. If combining the per-sentence answers did not give each
// check's answer on the whole text, the report would name a sentence as unread while a check had
// read it, or the other way round. So the checks split the same way (task-phrases.mjs), and
// requirement-sentences.test.mjs holds the invariant against every task file in agent/fixtures,
// re-wrapped at several widths, and every rephrasing the predicates are tested with.

import { taskRequiresImmutability } from "./immutability.mjs";
import { taskRetentionRequirement } from "./retention.mjs";
import { taskRequiresRotation } from "./secret-rotation.mjs";
import { taskWantsTests, taskWantsErrorDistinction } from "./code-quality.mjs";
import { artifactRequirements } from "./artifact-presence.mjs";
import { splitSentences } from "./task-phrases.mjs";

export { splitSentences };

/**
 * Each task-gated check's recogniser: the predicate the check itself uses, asked of one sentence.
 * The names are the validators' own, as they appear in "validators run".
 */
export const RECOGNISERS = [
  { check: "immutability", recognises: (s) => taskRequiresImmutability(s) },
  { check: "retention", recognises: (s) => Boolean(taskRetentionRequirement(s)) },
  { check: "secret_rotation", recognises: (s) => taskRequiresRotation(s) },
  { check: "tests", recognises: (s) => taskWantsTests(s) },
  { check: "error distinction", recognises: (s) => taskWantsErrorDistinction(s) },
  ...artifactRequirements().map((a) => ({ check: `artifact_presence (${a.id})`, recognises: (s) => a.taskPhrase(s) })),
];

/** Every sentence, with the checks that read it. */
export function judgeSentences(text = "") {
  return splitSentences(text).map((s) => ({
    ...s,
    checks: RECOGNISERS.filter((r) => r.recognises(s.text)).map((r) => r.check),
  }));
}

/**
 * The sentences no check read -- headings aside, which are labels rather than requirements -- as
 * { line, text }, with any line break inside one shown as a space.
 */
export function unjudgedSentences(text = "") {
  return judgeSentences(text)
    .filter((s) => !s.heading && s.checks.length === 0)
    .map((s) => ({ line: s.line, text: s.text.replace(/\s*\n\s*/g, " ") }));
}
