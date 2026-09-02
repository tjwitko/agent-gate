// Deciding what a task asked for, from prose the task author wrote freely.
//
// Three gates have now had the same defect: a list of literal tool names standing in for the
// requirement itself, so the requirement was recognised only when the task happened to name the
// tool this project's checks look for. immutability went 1/7 to 7/8 on rephrasings once it stopped
// requiring the word "immutable"; secret-rotation went 2/7 to 8/8. This module exists so the fourth
// gate does not re-derive the same two shapes, and so the traps below are paid for once.
//
// Two shapes cover every case so far:
//
//   any   — terms that name the requirement on their own ("kubernetes", "terraform", "IaC")
//   near  — a term too ambiguous to stand alone, paired with a noun that disambiguates it, in
//           EITHER order ("ship it as a container", "the container we ship")
//
// Three traps, each already paid for:
//
//  1. **Clause boundaries.** A proximity span must be [^.;\n]{0,N}, never [^.]{0,N}. With [^.],
//     "deploys run every month; the api key lives in Secrets Manager" matched across the semicolon
//     and was read as a rotation requirement. A semicolon and a newline end a thought as surely as
//     a full stop does.
//  2. **No stemming of ambiguous verbs.** `roll\w*` matches "rolling deployment". Spell the forms
//     out — rolls?|rolled — so a verb that is ambiguous on purpose cannot widen itself.
//  3. **Explicit plurals.** /\bsigning\s+key\b/ does NOT match "signing keys": the \b lands
//     between "key" and "s". Every noun in a list needs its own `s?`.
const CLAUSE = (n) => `[^.;\\n]{0,${n}}`;

const DEFAULT_WINDOW = 60;

/**
 * Builds a matcher from unambiguous alternatives and disambiguating pairs.
 *
 *   taskMatcher({
 *     any: [/\bterraform\b/i],
 *     near: [{ terms: "declares?|declared", nouns: "cloud resources?", window: 40 }],
 *   })
 *
 * `terms` and `nouns` are regex-source strings, not RegExp objects, because they are spliced into
 * a pattern built in both orders.
 */
export function taskMatcher({ any = [], near = [] } = {}) {
  const proximity = near.flatMap(({ terms, nouns, window = DEFAULT_WINDOW }) => [
    new RegExp(`\\b(?:${terms})\\b${CLAUSE(window)}\\b(?:${nouns})\\b`, "i"),
    new RegExp(`\\b(?:${nouns})\\b${CLAUSE(window)}\\b(?:${terms})\\b`, "i"),
  ]);
  const all = [...any, ...proximity];
  return (text = "") => all.some((re) => re.test(text));
}
