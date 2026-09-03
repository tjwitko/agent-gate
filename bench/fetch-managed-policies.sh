#!/usr/bin/env bash
# Regenerate agent/fixtures/aws-managed-policies.txt.
#
#   bench/fetch-managed-policies.sh
#
# iam-contract carried 37 hardcoded policy names, so most real ones came back "not in this check's
# known list" -- an advisory appearing in most graded runs that said, correctly, that it was not
# evidence of anything. AWS publishes well over a thousand.
#
# The list is parsed from the reference page's own anchors, keeping only links whose href slug
# equals their link text: on that page a policy entry is a link to its own detail page, and that
# pairing is what separates an entry from navigation chrome. Deliberately NOT transcribed by a
# model -- a fabricated name here would be silently accepted as real, which is the one failure this
# check exists to prevent.
#
# Definitive alternative, when credentials exist:
#   aws iam list-policies --scope AWS --query 'Policies[].PolicyName' --output text | tr '\t' '\n' | sort
set -euo pipefail

URL="https://docs.aws.amazon.com/aws-managed-policy/latest/reference/policy-list.html"
OUT="$(cd "$(dirname "$0")/.." && pwd)/agent/fixtures/aws-managed-policies.txt"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -sS --fail --max-time 60 -o "$TMP/page.html" "$URL"

python3 - "$TMP/page.html" "$TMP/names.txt" <<'PY'
import re, sys
html = open(sys.argv[1], encoding="utf-8").read()
pairs = re.findall(r'href="(?:\./)?([A-Za-z][A-Za-z0-9_+=,.@-]{2,127})\.html"[^>]*>([^<]+)</a>', html)
names = sorted({t.strip() for slug, t in pairs if t.strip() == slug})
if len(names) < 500:
    sys.exit(f"only {len(names)} names parsed — the page structure has probably changed; refusing to "
             f"overwrite the fixture with a partial list")
open(sys.argv[2], "w").write("\n".join(names) + "\n")
print(f"parsed {len(names)} policy names")
PY

{
  echo "# AWS managed policy names, one per line. Lines starting with # are ignored."
  echo "# Source: $URL"
  echo "# Generated: $(date -u +%Y-%m-%d) by bench/fetch-managed-policies.sh"
  echo "#"
  echo "# Absence from this list does NOT mean a policy does not exist: AWS adds policies"
  echo "# continually and this file has a date. It suppresses noise for names known to be real; it"
  echo "# never proves a name wrong on its own."
  cat "$TMP/names.txt"
} > "$OUT"

echo "wrote $OUT ($(grep -vc '^#' "$OUT") names)"
