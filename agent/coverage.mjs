// Source in languages no language-aware check reads.
//
// A Rust project exited 0. Each check that reads code said "not checked — no source files in a
// language this check recognises", as one advisory among several, and the verdict line said nothing
// blocking. True, and it reads as a pass: a reader who stops at the verdict has no way to learn that
// none of the code was looked at. The project-wide scans -- secrets, dependencies, infrastructure --
// still apply to such a project, which is why this is a line above the verdict rather than an exit 3:
// the gate ran; it just could not read the code it was given.
//
// Shell is deliberately not listed. Nearly every repository carries scripts, and a line that appears
// everywhere is a line nobody reads. The languages here are the ones a project's application code is
// written in.
import { readdirSync } from "fs";
import path from "path";

import { SKIP_DIRS } from "./skip-dirs.mjs";
import { isDeclaredFixture } from "./fixture-markers.mjs";
import { READ_EXT } from "./source-files.mjs";
import { SAST_EXT } from "./sast.mjs";

export const UNREAD_LANGUAGES = {
  ".php": "PHP",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".scala": "Scala",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".dart": "Dart",
  ".lua": "Lua",
  ".pl": "Perl",
  ".vue": "Vue",
  ".svelte": "Svelte",
};

// The code languages among the extensions the checks do read; configuration and SQL are read too,
// but are not what "most of the source" means.
// Every extension a language-aware check reads. Taken from sast's list rather than kept here: this file
// once called .jsx unread while sast was reading it, which is the drift a second list invites.
const READ_CODE = [...new Set([...READ_EXT, ...SAST_EXT])].filter((e) => ![".sql", ".tf", ".tfvars", ".yaml", ".yml"].includes(e));

// The language of each code file some check reads. A check that reads some of these and not others
// cannot vouch for a project holding the others: authentication reads Python and not C#.
export const READ_LANGUAGES = {
  ".py": "Python", ".go": "Go", ".java": "Java", ".rb": "Ruby", ".cs": "C#", ".rs": "Rust",
  ".js": "JavaScript/TypeScript", ".mjs": "JavaScript/TypeScript", ".cjs": "JavaScript/TypeScript",
  ".jsx": "JavaScript/TypeScript", ".ts": "JavaScript/TypeScript", ".tsx": "JavaScript/TypeScript",
  ".c": "C/C++", ".h": "C/C++", ".cc": "C/C++", ".cpp": "C/C++", ".cxx": "C/C++", ".hpp": "C/C++", ".hh": "C/C++",
};

/**
 * `languages` counts every code file by language, read or not.
 * @returns {{ unread: { language: string, files: number }[], unreadFiles: number, readFiles: number, mostlyUnread: boolean, languages: Record<string, number> }}
 */
export function sourceCoverage(projectDir) {
  const unread = new Map();
  const languages = {};
  let readFiles = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !isDeclaredFixture(full)) walk(full);
        continue;
      }
      const ext = path.extname(e.name);
      if (READ_CODE.includes(ext)) readFiles++;
      const language = UNREAD_LANGUAGES[ext];
      if (language) unread.set(language, (unread.get(language) || 0) + 1);
      const any = language || READ_LANGUAGES[ext];
      if (any) languages[any] = (languages[any] || 0) + 1;
    }
  };
  walk(projectDir);
  const list = [...unread].map(([language, files]) => ({ language, files })).sort((a, b) => b.files - a.files);
  const unreadFiles = list.reduce((n, l) => n + l.files, 0);
  return { unread: list, unreadFiles, readFiles, mostlyUnread: unreadFiles > readFiles, languages };
}

/** One sentence for both renderers, or null when everything is in a language something reads. */
export function coverageLine(cov) {
  if (!cov || cov.unreadFiles === 0) return null;
  const what = cov.unread.map((l) => `${l.files} ${l.language}`).join(", ");
  return cov.mostlyUnread
    ? `MOST OF THIS PROJECT'S SOURCE WAS NOT READ: ${what} file(s), against ${cov.readFiles} in languages the checks read. ` +
        `No language-aware check reads these, so the verdict says nothing about that code — only the project-wide scans (secrets, dependencies, infrastructure) apply to it.`
    : `${what} file(s) were not read — no language-aware check reads them, so the verdict says nothing about that code. ` +
        `Only the project-wide scans (secrets, dependencies, infrastructure) apply to it.`;
}
