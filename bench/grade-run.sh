#!/usr/bin/env bash
# Validate a finished run and print the evidence needed to grade it.
#
#   bench/grade-run.sh <run-name|path> [--install]
#
# --install copies the project to a scratch directory, runs `npm install` THERE, and re-runs the
# suite so a project that shipped without its toolchain can still be measured. The copy is used
# deliberately: installing into the deliverable changes what is being graded, and `npm install` on a
# generated manifest executes arbitrary postinstall hooks, which is not something to do to a
# directory you intend to keep.
set -euo pipefail

LLM_ROOT="${LLM_ROOT:-$HOME/LLM}"
CONTROLS="$LLM_ROOT/local-delegate-mcp"
# Default only. The real answer comes from the run itself, below: a run built for one task and
# graded against another reports its task-gated checks as "not checked" on a project that was asked
# for exactly those things, which reads as the model omitting them.
TASK="$CONTROLS/agent/fixtures/webhook-receiver-task.txt"

[ $# -ge 1 ] || { echo "usage: $(basename "$0") <run-name|path> [--install]" >&2; exit 2; }

ARG="$1"; shift
INSTALL=0
for a in "$@"; do [ "$a" = "--install" ] && INSTALL=1; done

# A bare name may be a run of any task now. Try it as given first, then the webhook prefix the
# eleven graded runs used, so `grade-run.sh haiku-2` keeps working.
if [ -d "$ARG" ]; then DIR="$(cd "$ARG" && pwd)"
elif [ -d "$LLM_ROOT/$ARG" ]; then DIR="$LLM_ROOT/$ARG"
else DIR="$LLM_ROOT/webhook-$ARG"; fi
[ -d "$DIR" ] || { echo "no such run: $DIR" >&2; exit 1; }

# Written by new-run.sh. Absent for a run scaffolded before this existed, which is every graded run
# so far -- those are all the webhook task, which is the default.
if [ -f "$DIR/.bench-task" ]; then
  RECORDED="$(head -1 "$DIR/.bench-task")"
  if [ -f "$RECORDED" ]; then
    TASK="$RECORDED"
  else
    echo "  !! $DIR/.bench-task names $RECORDED, which does not exist." >&2
    echo "     Grading against $TASK instead; task-gated checks may not match what was asked." >&2
  fi
fi

echo "===================================================================="
echo " run      : $DIR"
# Printed because a grader that silently used a different task than the run was built for is the
# mismatch .bench-task exists to prevent, and a reader cannot tell from the verdict alone.
echo " task     : $(basename "$TASK")"
# All five control repos, because the gate is not one repository. Two runs once carried identical
# "controls @" lines while dep-audit had changed between them.
for r in local-delegate-mcp terraform-guard-mcp dep-audit-mcp secret-guard-mcp identity-guard-mcp; do
  d="$LLM_ROOT/$r"
  sha="$(git -C "$d" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  git -C "$d" diff --quiet 2>/dev/null || sha="$sha (UNCOMMITTED — grade not reproducible)"
  printf " %-22s %s\n" "$r" "$sha"
done
[ -f "$DIR/RUN.md" ] && sed -n 's/^- /            /p' "$DIR/RUN.md"
echo "===================================================================="
echo
echo "---- what the model wrote -------------------------------------------"
COMMITS="$(git -C "$DIR" log --oneline 2>/dev/null | sed '$d')"   # drops the scaffold baseline
echo "${COMMITS:-  (no commits beyond the scaffold baseline)}" | sed 's/^/  /' 
echo
echo "  files (excluding node_modules/.terraform/.git):"
find "$DIR" -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.terraform/*" \
  | sed "s#$DIR/#    #" | sort
echo
echo "---- validators ------------------------------------------------------"
# PIPESTATUS, not $? -- after a pipeline $? is grep's status, so a run with blocking findings
# exited 0 and would have passed anything checking this script's result.
set +e
node "$CONTROLS/agent/validate-project.mjs" "$DIR" "$TASK" 2>&1 | grep -v "running on stdio"
VERDICT=${PIPESTATUS[0]}
set -e

if [ "$INSTALL" = "1" ]; then
  echo
  echo "---- test suite, dependencies installed in a scratch copy -----------"
  SCRATCH="$(mktemp -d)/proj"
  trap 'rm -rf "$(dirname "$SCRATCH")"' EXIT
  cp -R "$DIR" "$SCRATCH"
  if [ -f "$SCRATCH/package.json" ]; then
    ( cd "$SCRATCH" && npm install --no-audit --no-fund >/dev/null 2>&1 ) \
      || echo "  npm install failed — the suite cannot be measured this way"
  fi
  node --input-type=module -e "
    const m = await import('$CONTROLS/agent/test-execution.mjs');
    const r = m.testExecutionReport('$SCRATCH', { wanted: true });
    for (const f of r.failures) console.log('  BLOCKING ' + f);
    for (const a of r.advisories) console.log('  ' + a);
  "
  echo
  echo "  (the deliverable itself was not modified; the copy is deleted on exit)"
fi

echo
echo "---- grade on the three axes ----------------------------------------"
echo "  1. did the controls prevent insecure code   — read BLOCKING above"
echo "  2. did it complete a testable project       — read the tests line above"
echo "  3. overall code quality                     — read the advisories above"
echo
exit "$VERDICT"
