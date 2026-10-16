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
  return (text = "") => inAnySentence(text, (s) => all.some((re) => re.test(s)));
}

// --- sentences ---------------------------------------------------------------------------------
//
// Every requirement-reader asks its question of one sentence at a time, and they all split the text
// the same way, here. Two defects made this necessary, both measured on the fixture task files:
//
//  1. **Hard wrapping.** Task files are wrapped at a column, and a proximity span stops at a
//     newline, so a requirement that wrapped was not read. Re-wrapped at 30 columns, "- Records are
//     retained for / seven years" switched retention off for both the webhook and Slack tasks. A
//     line indented under a list item is that item continuing, and is joined with a space. Any
//     other line break still ends a thought, as trap 1 above says: "The queue must not back up /
//     workers delete messages" is two statements, and joining it invented an immutability
//     requirement.
//  2. **Crossing sentences.** secret-rotation tested for a secret word anywhere in the text and a
//     rotation word anywhere in it, so "We rotate the on-call engineer weekly. Store the API key in
//     Secrets Manager." stated a rotation requirement -- two of its own negative test cases, side
//     by side. The cost of scoping it: "It must be rotated every 90 days", after a sentence naming
//     the secret, no longer reads as rotation on its own. It is reported as a sentence no check
//     read, which is the point of the report, rather than passing silently either way.
//
// The same split decides which sentences the gate reports as read by no check
// (requirement-sentences.mjs), so the report and the checks cannot disagree about what a sentence is.

const LIST_MARKER = /^(?:[-*+•]|\d+[.)])\s+/;
// A heading is a markdown heading or a line with capitals and no lower case -- "REQUIREMENTS",
// "HOW WE WILL JUDGE IT". Readers still match it, since a heading can name a requirement
// ("TERRAFORM"); the report does not list it as unread, being a label.
const isHeading = (t) => /^#{1,6}\s/.test(t) || (/[A-Z]/.test(t) && !/[a-z]/.test(t));
// A sentence ends at . ! or ? followed by space and something that starts a sentence -- but not
// after an abbreviation, since "e.g. Secrets Manager" is one sentence. Requiring the space keeps
// "v1.2" whole. A semicolon does not end one; it ends a clause, which the proximity spans above
// already refuse to cross.
const SENTENCE_END = /(?<=[.!?])(?<!\b(?:e\.g|i\.e|etc|vs|cf|incl|approx)\.)\s+(?=[A-Z0-9"'`(\[])/;

/**
 * The text as sentences, each with the line it starts on.
 * @returns {{ text: string, line: number, heading: boolean }[]}
 */
export function splitSentences(text = "") {
  const blocks = [];
  let cur = null;
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (!t) { cur = null; return; }
    if (isHeading(t)) {
      blocks.push({ text: t.replace(/^#{1,6}\s+/, ""), line: i + 1, heading: true });
      cur = null;
      return;
    }
    if (!cur || LIST_MARKER.test(t)) {
      // `starts` maps an offset in the joined text to the line it came from, so a sentence reports
      // the line it begins on rather than the first line of its paragraph.
      cur = { text: t.replace(LIST_MARKER, ""), line: i + 1, heading: false, item: LIST_MARKER.test(t), starts: [[0, i + 1]] };
      blocks.push(cur);
    } else {
      cur.text += cur.item && /^\s/.test(raw) ? " " : "\n";
      cur.starts.push([cur.text.length, i + 1]);
      cur.text += t;
    }
  });
  const out = [];
  for (const b of blocks) {
    if (b.heading) { out.push({ text: b.text, line: b.line, heading: true }); continue; }
    let at = 0;
    for (const piece of b.text.split(SENTENCE_END)) {
      const start = b.text.indexOf(piece, at);
      at = start + piece.length;
      const line = b.starts.filter(([off]) => off <= start).pop()[1];
      if (piece.trim()) out.push({ text: piece.trim(), line, heading: false });
    }
  }
  return out;
}

/** Whether any one sentence of the text satisfies `test`. */
export function inAnySentence(text, test) {
  return splitSentences(text).some((s) => test(s.text));
}
