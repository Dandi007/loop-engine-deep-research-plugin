#!/usr/bin/env node
// C2 test fixture —— a real (test-provided) session-level workflow.js stand-in.
// The real light engine lives outside this repo (spec C2 constraint: the repo adds only
// the routing entry and does not reimplement the light tier). This fixture records the
// exact argv it was invoked with so test/c2-invocation.test.ts can assert the single entry
// forwards --topic and --sources verbatim, then exits 0.
import { writeFileSync } from "node:fs";

const recordFile = process.env.SESSION_RECORD_FILE;
if (!recordFile) {
  process.stderr.write("SESSION_RECORD_FILE is required\n");
  process.exit(2);
}
const argv = process.argv.slice(2);
writeFileSync(recordFile, JSON.stringify({ argv }) + "\n");
process.exit(0);