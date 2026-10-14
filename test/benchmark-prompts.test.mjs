import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const promptFiles = [
  new URL("../benchmarks/examples/radar-equations-prompts.json", import.meta.url),
  new URL("../benchmarks/examples/radar-equations-prompts-verbose.json", import.meta.url),
];

test("coverage benchmark prompts prevent oversized rewrites and bound retries", () => {
  for (const file of promptFiles) {
    const { prompts } = JSON.parse(readFileSync(file, "utf8"));
    const coveragePrompts = prompts.filter(({ id }) => id.startsWith("coverage-report"));
    assert.ok(coveragePrompts.length >= 2, `${file.pathname} should include repeated coverage checkpoints`);
    for (const { id, text } of coveragePrompts) {
      assert.match(text, /do not create or rewrite files/i, `${id} should avoid oversized writes`);
      assert.match(text, /do not use the write tool/i, `${id} should prevent whole-file writes`);
      assert.match(text, /at most one edit call/i, `${id} should cap edits per prompt`);
      assert.match(text, /newText no longer than 1,000 characters/i, `${id} should bound edit size`);
      assert.match(text, /stop all edits immediately/i, `${id} should stop after a truncated response`);
      assert.match(text, /never estimate coverage/i, `${id} should require measured coverage`);
    }
  }
});
