import assert from "node:assert/strict";
import test from "node:test";
import { flattenWorkContextMetrics, summarizeWorkContext, workTurnContext } from "../benchmarks/benchmark-metrics.mjs";

test("separates work, compression, and source-discovery assistant usage", () => {
  const ordinary = workTurnContext({
    role: "assistant",
    content: [{ type: "toolCall", name: "bash" }],
    usage: { input: 900, output: 300, cacheRead: 50, cacheWrite: 10 },
  }, "2026-10-10T10:00:00.000Z");
  const bigPi = workTurnContext({
    role: "assistant",
    content: [{ type: "toolCall", name: "big_pi_compress" }],
    usage: { input: 600, output: 200 },
  });
  const discovery = workTurnContext({
    role: "assistant",
    content: [{ type: "toolCall", name: "big_pi_compression_sources" }],
    usage: { input: 250, output: 30 },
  });
  const billionContextPi = workTurnContext({
    role: "assistant",
    content: [{ type: "toolCall", name: "compress" }],
    usage: { input: 700, output: 120 },
  });
  const summary = summarizeWorkContext([ordinary, bigPi, discovery, billionContextPi]);

  assert.deepEqual(ordinary, {
    category: "work",
    promptContextTokens: 960,
    outputTokens: 300,
    estimatedContextAfterCompletion: 1260,
    completedAt: "2026-10-10T10:00:00.000Z",
  });
  assert.equal(bigPi.category, "compressionAttempt");
  assert.equal(discovery.category, "otherBigPiTool");
  assert.equal(billionContextPi.category, "compressionAttempt");
  assert.equal(summary.workTurnsWithUsage, 1);
  assert.equal(summary.workTurnsWithUsage, 1);
  assert.equal(summary.latestWorkPromptContextTokens, 960);
  assert.equal(summary.estimatedContextAfterLatestWorkCompletion, 1260);
  assert.equal("inputTokens" in summary, false);
  assert.deepEqual(summary.usageByTurnCategory.work, {
    turns: 1,
    promptContextTokens: 960,
    outputTokens: 300,
    peakPromptContextTokens: 960,
    latestPromptContextTokens: 960,
  });
  assert.equal(summary.usageByTurnCategory.compressionAttempt.promptContextTokens, 1300);
  assert.equal(summary.usageByTurnCategory.otherBigPiTool.outputTokens, 30);
  assert.deepEqual(flattenWorkContextMetrics(summary), {
    peakWorkPromptContextTokens: 960,
    peakEstimatedContextAfterWorkCompletion: 1260,
    latestWorkPromptContextTokens: 960,
    estimatedContextAfterLatestWorkCompletion: 1260,
  });
});

test("classifies a turn that mixes compression and discovery separately", () => {
  const mixed = workTurnContext({
    role: "assistant",
    content: [
      { type: "toolCall", name: "big_pi_compression_sources" },
      { type: "toolCall", name: "big_pi_compress" },
    ],
    usage: { input: 400, output: 50 },
  });
  assert.equal(mixed.category, "compressionAndOtherBigPi");
  assert.equal(summarizeWorkContext([mixed]).usageByTurnCategory.compressionAndOtherBigPi.promptContextTokens, 400);
});

test("returns unavailable context values when no ordinary usage is reported", () => {
  assert.equal(workTurnContext({ role: "assistant", usage: null }), null);
  const summary = summarizeWorkContext([]);
  assert.equal(summary.workTurnsWithUsage, 0);
  assert.equal(summary.latestWorkPromptContextTokens, null);
  assert.equal(flattenWorkContextMetrics(summary).peakWorkPromptContextTokens, null);
});
