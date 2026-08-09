#!/usr/bin/env python3
"""
anchor-check.py — deterministic anchor verification for deep-research evidence.

Interface:
  anchor-check.py --corpus <json-file> [--repo-root <path>] --json

The corpus file is a JSON array of evidence objects, each with:
  { clue_id, anchor, quote, claim }

For each evidence, the tool locates the anchor in the repo and validates it.
Anchors are in the format: <file-path>:<line-number>

Output (--json):
  { "total": N, "current_parsed": N, "current_verified_hit": N,
    "current_failed": N, "old_format": N, "unparseable": N,
    "discarded": N, "sums_ok": bool,
    "loud_failures": [ {"anchor": …, "error": …} ] }

Validation rules:
  - current_parsed: anchors matching "<path>:<int>" (current format)
  - current_verified_hit: parsed anchors where file exists and line is valid
  - current_failed: parsed anchors where file exists but line is out of range
  - old_format: anchors that don't match "<path>:<int>" but contain ":"
  - unparseable: anchors that don't contain ":" at all
  - discarded: anchors that reference a file not found in repo-root
  - loud_failures: anchors where file exists but the repo-root is not set
    (cannot verify without repo root)
  - sums_ok: true when current_parsed + old_format + unparseable + discarded == total
"""

import argparse
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple


def parse_anchor(anchor: str) -> Tuple[Optional[str], Optional[int], str]:
    """Parse an anchor string. Returns (file_path, line_number, format_kind)."""
    anchor = anchor.strip()
    if ":" not in anchor:
        return None, None, "unparseable"
    parts = anchor.rsplit(":", 1)
    if len(parts) != 2:
        return None, None, "old_format"
    file_path, line_str = parts
    try:
        line_num = int(line_str)
    except ValueError:
        return None, None, "old_format"
    if line_num < 1:
        return None, None, "old_format"
    return file_path, line_num, "current"


def validate_anchor(
    file_path: str,
    line_num: int,
    repo_root: Optional[str],
) -> Tuple[bool, Optional[str]]:
    """Validate an anchor. Returns (is_valid, error_message)."""
    if not repo_root:
        return False, "repo-root not set: cannot verify anchor location"
    full_path = os.path.join(repo_root, file_path)
    if not os.path.isfile(full_path):
        return False, "discarded"
    try:
        with open(full_path, "r", encoding="utf-8", errors="replace") as f:
            for i, _ in enumerate(f, 1):
                if i >= line_num:
                    return True, None
    except Exception:
        return False, "discarded"
    return False, f"line {line_num} out of range (file has fewer lines)"


def process_corpus(
    evidences: List[Dict[str, Any]],
    repo_root: Optional[str],
) -> Dict[str, Any]:
    total = len(evidences)
    current_parsed = 0
    current_verified_hit = 0
    current_failed = 0
    old_format = 0
    unparseable = 0
    discarded = 0
    loud_failures: List[Dict[str, str]] = []

    for ev in evidences:
        anchor = ev.get("anchor", "").strip()
        if not anchor:
            unparseable += 1
            continue

        file_path, line_num, fmt = parse_anchor(anchor)

        if fmt == "unparseable":
            unparseable += 1
        elif fmt == "old_format":
            old_format += 1
        elif fmt == "current":
            if file_path is None or line_num is None:
                current_parsed += 1
                current_failed += 1
                continue

            is_valid, error = validate_anchor(file_path, line_num, repo_root)
            if error == "discarded":
                discarded += 1
            elif error and "repo-root not set" in error:
                current_parsed += 1
                current_failed += 1
                loud_failures.append({"anchor": anchor, "error": error})
            elif is_valid:
                current_parsed += 1
                current_verified_hit += 1
            else:
                current_parsed += 1
                current_failed += 1
                if error:
                    loud_failures.append({"anchor": anchor, "error": error})

    sums_ok = (current_parsed + old_format + unparseable + discarded) == total

    return {
        "total": total,
        "current_parsed": current_parsed,
        "current_verified_hit": current_verified_hit,
        "current_failed": current_failed,
        "old_format": old_format,
        "unparseable": unparseable,
        "discarded": discarded,
        "sums_ok": sums_ok,
        "loud_failures": loud_failures,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Deterministic anchor verification for deep-research evidence."
    )
    parser.add_argument(
        "--corpus",
        required=True,
        help="Path to JSON file containing evidence array (or bus:<channel> for bus mode)",
    )
    parser.add_argument(
        "--repo-root",
        default=None,
        help="Path to the repository root for anchor resolution",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        required=True,
        help="Output results as JSON",
    )
    args = parser.parse_args()

    corpus_path = args.corpus
    if corpus_path.startswith("bus:"):
        print(json.dumps({"error": "bus mode not yet implemented"}, indent=2), file=sys.stderr)
        sys.exit(1)

    if not os.path.isfile(corpus_path):
        print(json.dumps({"error": f"corpus file not found: {corpus_path}"}, indent=2), file=sys.stderr)
        sys.exit(1)

    try:
        with open(corpus_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(json.dumps({"error": f"failed to read corpus: {e}"}, indent=2), file=sys.stderr)
        sys.exit(1)

    if not isinstance(raw, list):
        print(json.dumps({"error": "corpus must be a JSON array"}, indent=2), file=sys.stderr)
        sys.exit(1)

    repo_root = args.repo_root
    if repo_root and not os.path.isdir(repo_root):
        print(json.dumps({"error": f"repo-root is not a directory: {repo_root}"}, indent=2), file=sys.stderr)
        sys.exit(1)

    result = process_corpus(raw, repo_root)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()