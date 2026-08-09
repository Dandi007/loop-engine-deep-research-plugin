#!/usr/bin/env bash
set -euo pipefail
# anchor-check-selftest.sh — regression tests for anchor-check.py
# Must be run from the tools/ directory (or with TOOLS_DIR set).

TOOLS_DIR="${TOOLS_DIR:-$(cd "$(dirname "$0")" && pwd)}"
AC_PY="${TOOLS_DIR}/anchor-check.py"
FIXTURES="${TOOLS_DIR}/fixtures"
TMPDIR="${TMPDIR:-/tmp}"
WORKDIR=""

cleanup() {
  if [ -n "${WORKDIR:-}" ] && [ -d "$WORKDIR" ]; then
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

WORKDIR=$(mktemp -d "${TMPDIR}/anchor-check-selftest-XXXXXX")

# Guard: anchor-check.py exists
if [ ! -f "$AC_PY" ]; then
  echo "FAIL: anchor-check.py not found at $AC_PY"
  exit 1
fi

# Guard: fixtures directory exists
if [ ! -d "$FIXTURES" ]; then
  echo "FAIL: fixtures directory not found at $FIXTURES"
  exit 1
fi

echo "=== anchor-check selftest ==="

# Test 1: empty corpus
echo -n "T1 empty corpus: "
echo '[]' > "${WORKDIR}/empty.json"
result=$(python3 "$AC_PY" --corpus "${WORKDIR}/empty.json" --json 2>&1)
total=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])")
if [ "$total" != "0" ]; then
  echo "FAIL (expected total=0, got $total)"
  exit 1
fi
echo "PASS"

# Test 2: all valid anchors using repo-root
echo -n "T2 valid anchors with repo-root: "
# Create a fixture with valid anchors pointing to anchor-check.py itself
cat > "${WORKDIR}/valid.json" << 'ENDJSON'
[
  {"clue_id":"c1","anchor":"tools/anchor-check.py:1","quote":"","claim":""},
  {"clue_id":"c2","anchor":"tools/anchor-check.py:10","quote":"","claim":""}
]
ENDJSON
result=$(python3 "$AC_PY" --corpus "${WORKDIR}/valid.json" --repo-root "$(cd "$TOOLS_DIR/.." && pwd)" --json 2>&1)
verified=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['current_verified_hit'])")
total=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['total'])")
if [ "$verified" != "2" ] || [ "$total" != "2" ]; then
  echo "FAIL (expected verified=2 total=2, got verified=$verified total=$total)"
  exit 1
fi
echo "PASS"

# Test 3: unparseable anchors (no colon)
echo -n "T3 unparseable anchors: "
cat > "${WORKDIR}/unparseable.json" << 'ENDJSON'
[
  {"clue_id":"c1","anchor":"no-colon-here","quote":"","claim":""},
  {"clue_id":"c2","anchor":"also-no-colon","quote":"","claim":""}
]
ENDJSON
result=$(python3 "$AC_PY" --corpus "${WORKDIR}/unparseable.json" --repo-root "$(cd "$TOOLS_DIR/.." && pwd)" --json 2>&1)
unparseable=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['unparseable'])")
total=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['total'])")
if [ "$unparseable" != "2" ] || [ "$total" != "2" ]; then
  echo "FAIL (expected unparseable=2, got $unparseable)"
  exit 1
fi
echo "PASS"

# Test 4: old_format anchors (non-numeric line)
echo -n "T4 old_format anchors: "
cat > "${WORKDIR}/oldfmt.json" << 'ENDJSON'
[
  {"clue_id":"c1","anchor":"file.txt:abc","quote":"","claim":""}
]
ENDJSON
result=$(python3 "$AC_PY" --corpus "${WORKDIR}/oldfmt.json" --repo-root "$(cd "$TOOLS_DIR/.." && pwd)" --json 2>&1)
old_fmt=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['old_format'])")
if [ "$old_fmt" != "1" ]; then
  echo "FAIL (expected old_format=1, got $old_fmt)"
  exit 1
fi
echo "PASS"

# Test 5: discarded anchors (file not found)
echo -n "T5 discarded anchors: "
cat > "${WORKDIR}/discarded.json" << 'ENDJSON'
[
  {"clue_id":"c1","anchor":"nonexistent/file.txt:1","quote":"","claim":""}
]
ENDJSON
result=$(python3 "$AC_PY" --corpus "${WORKDIR}/discarded.json" --repo-root "$(cd "$TOOLS_DIR/.." && pwd)" --json 2>&1)
discarded=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['discarded'])")
if [ "$discarded" != "1" ]; then
  echo "FAIL (expected discarded=1, got $discarded)"
  exit 1
fi
echo "PASS"

# Test 6: no repo-root — loud failure
echo -n "T6 no repo-root: "
cat > "${WORKDIR}/noroot.json" << 'ENDJSON'
[
  {"clue_id":"c1","anchor":"tools/anchor-check.py:1","quote":"","claim":""}
]
ENDJSON
result=$(python3 "$AC_PY" --corpus "${WORKDIR}/noroot.json" --json 2>&1)
loud=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['loud_failures']))")
if [ "$loud" != "1" ]; then
  echo "FAIL (expected loud_failures=1, got $loud)"
  exit 1
fi
echo "PASS"

# Test 7: sums_ok is true for a clean corpus
echo -n "T7 sums_ok: "
cat > "${WORKDIR}/mixed.json" << 'ENDJSON'
[
  {"clue_id":"c1","anchor":"tools/anchor-check.py:1","quote":"","claim":""},
  {"clue_id":"c2","anchor":"no-colon","quote":"","claim":""},
  {"clue_id":"c3","anchor":"old:fmt","quote":"","claim":""},
  {"clue_id":"c4","anchor":"nonexistent/file.txt:999","quote":"","claim":""}
]
ENDJSON
result=$(python3 "$AC_PY" --corpus "${WORKDIR}/mixed.json" --repo-root "$(cd "$TOOLS_DIR/.." && pwd)" --json 2>&1)
sums_ok=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d['sums_ok']).lower())")
if [ "$sums_ok" != "true" ]; then
  echo "FAIL (expected sums_ok=true, got $sums_ok)"
  exit 1
fi
echo "PASS"

# Test 8: missing corpus file
echo -n "T8 missing corpus file: "
if python3 "$AC_PY" --corpus "${WORKDIR}/does-not-exist.json" --json 2>/dev/null; then
  echo "FAIL (expected non-zero exit)"
  exit 1
fi
echo "PASS"

# Test 9: invalid repo-root
echo -n "T9 invalid repo-root: "
cat > "${WORKDIR}/simple.json" << 'ENDJSON'
[{"clue_id":"c1","anchor":"tools/anchor-check.py:1","quote":"","claim":""}]
ENDJSON
if python3 "$AC_PY" --corpus "${WORKDIR}/simple.json" --repo-root "/nonexistent/path/xyz" --json 2>/dev/null; then
  echo "FAIL (expected non-zero exit)"
  exit 1
fi
echo "PASS"

echo "=== ALL TESTS PASSED ==="