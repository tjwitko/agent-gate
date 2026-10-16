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

// --- sentences an always-on check already holds the project to ----------------------------------
//
// Some checks run on every project and switch on for nothing: secrets, injection, authentication,
// dependencies. A baseline sentence asking for what one of them blocks on is not a requirement the
// project escapes, and listing it as one made the "not held to these" headline false for most of an
// ASVS-style baseline -- and a headline people learn to skim is a control switched off.
//
// These recognisers label; they switch nothing on. Two rules keep the label honest:
//
//  1. Covered means the check BLOCKS ON what the sentence asks for -- the README's "blocks on" column --
//     not that it is about the same topic. Hashing passwords is not secret scanning; authorisation
//     and least privilege are not authentication; "no known vulnerabilities" is more than the high
//     and critical ones the dependency scan blocks on; a sentence naming LDAP or template injection
//     alongside SQL asks for more than the injection rules read. Each of those stays unread.
//  2. Covered only where the check reads the project's code, and only when it ran. authentication
//     reads five languages and sast nine; a project with C# in it is not covered for authentication,
//     and the sentence says why instead.

const SAST_LANGUAGES = ["Python", "JavaScript/TypeScript", "Go", "Java", "Ruby", "C#", "Rust", "C/C++"];
const AUTH_LANGUAGES = ["Python", "JavaScript/TypeScript", "Go", "Java", "Ruby"];

const NEGATED = /\b(?:not|never|no|without|free of|must not|mustn't|cannot)\b/i;
const CREDENTIAL = /\b(?:credentials?|secrets?|api[- ]keys?|passwords?|tokens?|private keys?|access keys?|keys)\b/i;
const IN_SOURCE = /\b(?:hard[- ]?cod\w*|embedded in (?:the )?(?:source|code)|in (?:the )?(?:source(?: code)?|code(?:base)?|repositor(?:y|ies)|repo|version control|git)|committed|checked in(?:to)?)\b/i;

// The classes the injection rules block on. Any other class named in the same sentence means it asks
// for more than they read.
const INJECTION_COVERED = [
  /\bparameteri[sz]ed (?:quer(?:y|ies)|statements?|sql)\b|\bprepared statements?\b|\bbind (?:variables|parameters)\b|\bsql injection\b/i,
  /\b(?:os |shell )?command injection\b|\bshell injection\b/i,
  /\bcode injection\b|\beval\(?\b/i,
  /\bssrf\b|\bserver[- ]side request forgery\b/i,
  /\b(?:path|directory) traversal\b/i,
];
const INJECTION_NOT_COVERED = /\b(?:ldap|xpath|nosql|xss|cross[- ]site|template|header|log|email|crlf|xml|html|css|expression language|el) injection\b|\bcross[- ]site scripting\b|\bxss\b|\bxxe\b|\bdeserializ\w*\b/i;

const AUTH_EVERY_ROUTE =
  /\bauthenticat\w*\b[^.;]{0,60}\b(?:all|every|each|any)\s+(?:\w+\s+)?(?:routes?|endpoints?|requests?|apis?|pages?|handlers?)\b|\b(?:all|every|each)\s+(?:\w+\s+)?(?:routes?|endpoints?|apis?|handlers?)\b[^.;]{0,60}\bauthenticat\w*\b|\bno unauthenticated (?:access|routes?|endpoints?|requests?)\b/i;
const NOT_AUTHENTICATION = /\bauthori[sz]\w*|\bleast privilege\b|\bpermissions?\b|\broles?\b|\baccess control\b|\brbac\b|\bmfa\b|\bmulti[- ]factor\b|\b2fa\b|\bsessions?\b|\bpasswords?\b|\blockout\b/i;

const DEPENDENCY = /\b(?:dependenc\w*|components?|librar(?:y|ies)|packages?|third[- ]party)\b/i;
const VULNERABLE = /\b(?:vulnerabilit\w*|cves?)\b/i;
const SEVERE = /\b(?:high|critical)\b/i;

export const ALWAYS_ON = [
  {
    check: "scan_path",
    recognises: (s) => CREDENTIAL.test(s) && IN_SOURCE.test(s) && NEGATED.test(s),
    reads: null, // every file, whatever the language
  },
  {
    check: "sast",
    recognises: (s) => INJECTION_COVERED.some((re) => re.test(s)) && !INJECTION_NOT_COVERED.test(s),
    reads: SAST_LANGUAGES,
  },
  {
    check: "authentication",
    recognises: (s) => AUTH_EVERY_ROUTE.test(s) && !NOT_AUTHENTICATION.test(s),
    reads: AUTH_LANGUAGES,
  },
  {
    check: "check_dependencies",
    recognises: (s) => DEPENDENCY.test(s) && VULNERABLE.test(s) && SEVERE.test(s),
    reads: null, // every lockfile OSV reads
  },
];

/**
 * Whether an always-on check holds this project to `sentence`.
 * Returns { coveredBy } when it does, { notCoveredBecause } when a check would but cannot here, or
 * null when no always-on check is about it.
 *
 * @param {{ languages?: Record<string, number>, ran?: string[], couldNotRun?: string[] }} project
 */
export function alwaysOnCoverage(sentence, { languages = {}, ran = [], couldNotRun = [] } = {}) {
  const r = ALWAYS_ON.find((x) => x.recognises(sentence));
  if (!r) return null;
  if (!ran.some((x) => x === r.check || x.startsWith(`${r.check}(`)) || couldNotRun.some((c) => c.startsWith(`${r.check}:`) || c.startsWith(`${r.check} `))) {
    return { notCoveredBecause: `${r.check} did not run here` };
  }
  const unread = r.reads ? Object.keys(languages).filter((l) => !r.reads.includes(l)) : [];
  if (unread.length) {
    return { notCoveredBecause: `${r.check} would cover it, but reads no ${unread.join(" or ")} code, which this project has` };
  }
  return { coveredBy: r.check };
}
