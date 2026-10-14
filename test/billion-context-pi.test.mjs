import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readBillionContextPiSummary } from "../benchmarks/billion-context-pi.mjs";

test("counts Billion Context Pi blocks by tier from the session sidecar", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "bcp-sidecar-test-"));
  try {
    const session = path.join(temp, "session.jsonl");
    await writeFile(`${session}.acp.json`, JSON.stringify({
      producer: "billion-context-pi@1.2.3", schemaVersion: 1,
      blocks: [{ blockId: "b1", tier: 1 }, { blockId: "b2", tier: 1 }, { blockId: "b3", tier: 3 }],
    }));
    assert.deepEqual(await readBillionContextPiSummary(session), {
      detected: true, sidecarPresent: true, manifestStatus: "valid", totalBlocks: 3,
      blocksByTier: { "1": 2, "2": 0, "3": 1 },
    });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("reports absent, malformed, foreign, unsupported, and invalid block manifests distinctly", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "bcp-sidecar-invalid-test-"));
  try {
    const session = path.join(temp, "session.jsonl");
    assert.equal((await readBillionContextPiSummary(session)).manifestStatus, "absent");
    const sidecar = `${session}.acp.json`;
    await writeFile(sidecar, "not json");
    assert.equal((await readBillionContextPiSummary(session)).manifestStatus, "malformed");
    await writeFile(sidecar, JSON.stringify({ producer: "other-extension@1", blocks: [] }));
    assert.equal((await readBillionContextPiSummary(session)).manifestStatus, "foreign");
    await writeFile(sidecar, JSON.stringify({ producer: "billion-context-pi@1", schemaVersion: 2, blocks: [] }));
    assert.equal((await readBillionContextPiSummary(session)).manifestStatus, "unsupported");
    await writeFile(sidecar, JSON.stringify({ producer: "billion-context-pi@1", blocks: [{ blockId: "b1", tier: 4 }] }));
    const invalid = await readBillionContextPiSummary(session);
    assert.equal(invalid.manifestStatus, "malformed");
    assert.equal(invalid.totalBlocks, null);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
