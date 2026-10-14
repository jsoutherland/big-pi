import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("runs the fixed prompt set in fresh projects and snapshots the effective Big Pi config", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "big-pi-benchmark-test-"));
  const promptsPath = path.join(temp, "prompts.json");
  const configPath = path.join(temp, "custom-config.json");
  const runsDir = path.join(temp, "runs");
  const projectsDir = path.join(temp, "projects");
  await writeFile(promptsPath, JSON.stringify({ prompts: [{ id: "first", text: "one" }, { id: "second", text: "two" }] }));
  const configText = JSON.stringify({ nudge: { mode: "percentage", thresholdPercentage: 55 } }, null, 2) + "\n";
  await writeFile(configPath, configText);
  const invocation = spawnSync(process.execPath, [
    path.join(root, "benchmarks", "benchmark.mjs"),
    "--prompts", promptsPath,
    "--extension", path.join(temp, "unused-extension.js"),
    "--config", configPath,
    "--pi", process.execPath,
    "--pi-arg", path.join(root, "test", "fake-pi.mjs"),
    "--runs-dir", runsDir,
    "--projects-dir", projectsDir,
    "--runs", "2",
    "--model", "fake-model",
  ], { encoding: "utf8", timeout: 120_000, env: { ...process.env, BIG_PI_GROWTH_TRIGGER_TOKENS: "1" } });
  try {
    if (invocation.error?.code === "EPERM") {
      t.skip("This sandbox blocks Node.js child processes; run this integration check on the target machine.");
      return;
    }
    assert.equal(invocation.status, 0, `${invocation.stdout}\n${invocation.stderr}`);
    assert.match(invocation.stdout, /\[1\/2\] first\s{2,}sending\s+\|  context \[ {5}100 \/ {3}1,000 tokens \]/);
    assert.match(invocation.stdout, /\[1\/2\] first\s{2,}initial request context measured\s+\|  context \[\s*100 \/\s*1,000 tokens \]/);
    assert.match(invocation.stdout, /\[1\/2\] first\s{2,}settled: .*\s+\|  context \[ {5}100 \/ {3}1,000 tokens \]/);
    const firstSendingStatus = invocation.stdout.indexOf("sending");
    const firstMeasuredStatus = invocation.stdout.indexOf("initial request context measured");
    const firstSettledStatus = invocation.stdout.indexOf("settled:", firstMeasuredStatus);
    assert.ok(firstSendingStatus >= 0 && firstSendingStatus < firstMeasuredStatus && firstMeasuredStatus < firstSettledStatus);
    const firstStatusLine = invocation.stdout.split("\n").find((line) => line.includes("[1/2] first") && line.includes(" sending "));
    const firstMeasuredLineText = invocation.stdout.split("\n").find((line) => line.includes("[1/2] first") && line.includes("initial request context measured"));
    const firstSettledLineText = invocation.stdout.split("\n").find((line) => line.includes("[1/2] first") && line.includes("settled:"));
    assert.equal(firstStatusLine.indexOf("sending"), firstMeasuredLineText.indexOf("initial request context measured"));
    assert.equal(firstStatusLine.indexOf("sending"), firstSettledLineText.indexOf("settled:"));
    assert.match(invocation.stdout, /\[2\/2\] second\s{2,}initial request context measured\s+\|  context \[\s*100 \/\s*1,000 tokens \]/);
    const secondSendingStatus = invocation.stdout.indexOf("sending", firstSettledStatus);
    const secondMeasuredStatus = invocation.stdout.indexOf("initial request context measured", secondSendingStatus);
    const secondSettledStatus = invocation.stdout.indexOf("settled:", secondMeasuredStatus);
    assert.ok(secondSendingStatus >= 0 && secondSendingStatus < secondMeasuredStatus && secondMeasuredStatus < secondSettledStatus);
    assert.match(invocation.stdout, /\d{4}-\d\d-\d\dT[^\n]+ Pi compaction started \(overflow\)/);
    assert.match(invocation.stdout, /\d{4}-\d\d-\d\dT[^\n]+ Pi compaction ended in .*s/);
    assert.match(invocation.stdout, /\d{4}-\d\d-\d\dT[^\n]+ Big Pi compression started/);
    assert.match(invocation.stdout, /\d{4}-\d\d-\d\dT[^\n]+ Big Pi compression ended in .*s \(context refresh pending\)/);
    assert.match(invocation.stdout, /\d{4}-\d\d-\d\dT[^\n]+ Big Pi compression context refreshed \(context after turn settled\)/);
    assert.doesNotMatch(invocation.stdout, /continued after Pi compaction/);
    const progressLines = invocation.stdout.split("\n").filter((line) => line.includes("|  context ["));
    assert.ok(progressLines.length >= 12);
    assert.equal(new Set(progressLines.map((line) => line.indexOf("|  context ["))).size, 1);
    const lifecycleLines = progressLines.filter((line) => /(?:compaction|compression) (?:started|ended)/.test(line));
    assert.ok(lifecycleLines.length >= 8);
    for (const line of lifecycleLines) assert.match(line, /context \[ {5}100 \/ {3}1,000 tokens \]/);
    const runNames = await readdir(runsDir);
    assert.equal(runNames.length, 2);
    const summaries = await Promise.all(runNames.map(async (name) => {
      const dir = path.join(runsDir, name);
      const summary = JSON.parse(await readFile(path.join(dir, "summary.json"), "utf8"));
      assert.equal(await readFile(path.join(dir, "big-pi-config.json"), "utf8"), configText);
      assert.equal(summary.configPath, path.join(dir, "big-pi-config.json"));
      assert.equal(summary.bigPi.committedBlocksByTier["1"], 1);
      assert.equal(summary.bigPi.committedBlocksByTier["2"], 1);
      assert.equal(summary.bigPi.committedBlocksByTier["3"], 1);
      assert.equal(summary.bigPi.appliedBlocksByTier["1"], 1);
      assert.equal(summary.modelContextUsage.workTurnsWithUsage, 2);
      assert.equal(summary.modelContextUsage.usageByTurnCategory.compressionAttempt.turns, 2);
      assert.equal(summary.modelContextUsage.usageByTurnCategory.compressionAttempt.promptContextTokens, 100);
      assert.equal(summary.modelContextUsage.usageByTurnCategory.otherBigPiTool.turns, 2);
      assert.equal(summary.modelContextUsage.usageByTurnCategory.otherBigPiTool.promptContextTokens, 50);
      assert.equal(summary.modelContextUsage.latestWorkPromptContextTokens, 100);
      assert.equal(summary.modelContextUsage.estimatedContextAfterLatestWorkCompletion, 110);
      assert.equal(summary.piCompactions.intervals[0].contextAtStart.tokens, 100);
      assert.equal(summary.piCompactions.peakContextAtStartTokens, 100);
      assert.equal("inputTokens" in summary.modelContextUsage, false);
      assert.equal(summary.prompts.length, 2);
      assert.equal(summary.completion.completedPrompts, 2);
      assert.equal(summary.piCompactions.count, 2);
      assert.equal(summary.bigPiToolCalls.calls.filter((call) => call.isCompression).length, 2);
      assert.equal(summary.bigPiToolCalls.calls.filter((call) => call.toolName === "big_pi_compression_sources").length, 2);
      assert.equal(summary.bigPiToolCalls.successfulCalls, 1);
      assert.equal(summary.bigPiToolCalls.unsuccessfulOrUnconfirmedCalls, 1);
      assert.equal(summary.bigPiToolCalls.otherToolTimeMs, 0);
      assert.ok(Number.isFinite(summary.bigPiToolCalls.successfulCompressionTimeMs));
      assert.ok(summary.bigPiToolCalls.successfulCompressionTimeMs >= 0);
      assert.ok(summary.bigPiToolCalls.successfulCompressionTimeMs <= summary.bigPiToolCalls.compressionAttemptTimeMs);
      assert.equal(summary.completion.stuck, false);
      assert.equal(await readFile(summary.artifacts.bigPiLogFile, "utf8"), "fake Big Pi development log\n");
      assert.deepEqual(await readdir(summary.artifacts.bigPiContextDumpsDir), ["fake-context-dump.txt"]);
      return summary;
    }));
    assert.notEqual(summaries[0].projectDir, summaries[1].projectDir);
    assert.notEqual(summaries[0].sessionDir, summaries[1].sessionDir);
    assert.equal(path.dirname(summaries[0].projectDir), projectsDir);
    assert.equal(path.dirname(summaries[1].projectDir), projectsDir);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("stock-Pi mode disables extension loading and inherited Big Pi settings", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "big-pi-stock-benchmark-test-"));
  try {
    const promptsPath = path.join(temp, "prompts.json");
    const runsDir = path.join(temp, "runs");
    await writeFile(promptsPath, JSON.stringify(["fixed prompt"]));
    const invocation = spawnSync(process.execPath, [
      path.join(root, "benchmarks", "benchmark.mjs"),
      "--prompts", promptsPath, "--stock-pi", "--pi", process.execPath,
      "--pi-arg", path.join(root, "test", "fake-pi.mjs"),
      "--runs-dir", runsDir, "--projects-dir", path.join(temp, "projects"),
    ], { encoding: "utf8", timeout: 30000, env: { ...process.env, BIG_PI_CONFIG: "must-be-cleared", BIG_PI_DEBUG: "1" } });
    if (invocation.error?.code === "EPERM") {
      t.skip("This sandbox blocks Node.js child processes; run this integration check on the target machine.");
      return;
    }
    assert.equal(invocation.status, 0, invocation.stdout + invocation.stderr);
    const [runName] = await readdir(runsDir);
    const runDir = path.join(runsDir, runName);
    const summary = JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf8"));
    const launch = JSON.parse(await readFile(path.join(summary.sessionDir, "fake-launch-info.json"), "utf8"));
    assert.equal(summary.benchmarkMode, "stock-pi");
    assert.equal(summary.extensionPath, null);
    assert.equal(summary.configPath, null);
    assert.equal(summary.piAutoCompactionEnabled, true);
    assert.equal(summary.bigPi.committedBlocks, 0);
    assert.equal(summary.bigPiToolCalls.calls.length, 0);
    assert.equal(summary.artifacts.bigPiManifestFile, null);
    assert.equal(launch.args.includes("--no-extensions"), true);
    assert.equal(launch.args.includes("--extension"), false);
    assert.deepEqual(launch.bigPiEnvironment, []);
    assert.equal((await readdir(runDir)).some((name) => name.startsWith("big-pi")), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Billion Context Pi mode loads only its extension and counts sidecar blocks", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "big-pi-bcp-benchmark-test-"));
  try {
    const promptsPath = path.join(temp, "prompts.json");
    const extensionPath = path.join(temp, "billion-context-pi.js");
    const runsDir = path.join(temp, "runs");
    await writeFile(promptsPath, JSON.stringify(["fixed prompt"]));
    await writeFile(extensionPath, "// fake BCP extension\n");
    const invocation = spawnSync(process.execPath, [
      path.join(root, "benchmarks", "benchmark.mjs"),
      "--prompts", promptsPath, "--billion-context-pi", extensionPath,
      "--pi", process.execPath, "--pi-arg", path.join(root, "test", "fake-pi.mjs"),
      "--runs-dir", runsDir, "--projects-dir", path.join(temp, "projects"),
    ], { encoding: "utf8", timeout: 30_000, env: { ...process.env, BIG_PI_CONFIG: "must-be-cleared", BIG_PI_DEBUG: "1" } });
    if (invocation.error?.code === "EPERM") {
      t.skip("This sandbox blocks Node.js child processes; run this integration check on the target machine.");
      return;
    }
    assert.equal(invocation.status, 0, invocation.stdout + invocation.stderr);
    assert.match(invocation.stdout, /Billion Context Pi blocks T1\/T2\/T3 1\/1\/1 \(total 3; valid\)/);
    const [runName] = await readdir(runsDir);
    const runDir = path.join(runsDir, runName);
    const summary = JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf8"));
    const launch = JSON.parse(await readFile(path.join(summary.sessionDir, "fake-launch-info.json"), "utf8"));
    assert.equal(summary.benchmarkMode, "billion-context-pi");
    assert.equal(summary.extensionPath, extensionPath);
    assert.equal(summary.configPath, null);
    assert.deepEqual(summary.billionContextPi.blocksByTier, { "1": 1, "2": 1, "3": 1 });
    assert.equal(summary.billionContextPi.totalBlocks, 3);
    assert.equal(summary.billionContextPi.manifestStatus, "valid");
    assert.equal(summary.artifacts.billionContextPiSidecarFile, `${summary.sessionFile}.acp.json`);
    assert.equal(summary.artifacts.bigPiManifestFile, null);
    assert.equal(launch.args.includes("--no-extensions"), true);
    assert.equal(launch.args[launch.args.indexOf("--extension") + 1], extensionPath);
    assert.deepEqual(launch.bigPiEnvironment, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("adds Billion Context Pi block metrics to a configuration grid", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "big-pi-bcp-grid-test-"));
  try {
    const promptsPath = path.join(temp, "prompts.json");
    const configPath = path.join(temp, "grid.json");
    const bigPiExtension = path.join(temp, "big-pi.js");
    const bcpExtension = path.join(temp, "billion-context-pi.js");
    const runsDir = path.join(temp, "runs");
    await writeFile(promptsPath, JSON.stringify(["fixed prompt"]));
    await writeFile(configPath, JSON.stringify({ name: "grid", configurations: [{ id: "base", config: {} }] }));
    await writeFile(bigPiExtension, "// fake Big Pi extension\n");
    await writeFile(bcpExtension, "// fake BCP extension\n");
    const invocation = spawnSync(process.execPath, [
      path.join(root, "benchmarks", "benchmark.mjs"),
      "--prompts", promptsPath, "--extension", bigPiExtension, "--config-set", configPath,
      "--include-stock", "--include-billion-context-pi", bcpExtension,
      "--pi", process.execPath, "--pi-arg", path.join(root, "test", "fake-pi.mjs"),
      "--runs-dir", runsDir, "--projects-dir", path.join(temp, "projects"),
    ], { encoding: "utf8", timeout: 30_000 });
    if (invocation.error?.code === "EPERM") {
      t.skip("This sandbox blocks Node.js child processes; run this integration check on the target machine.");
      return;
    }
    assert.equal(invocation.status, 0, invocation.stdout + invocation.stderr);
    const matrix = JSON.parse(await readFile(path.join(runsDir, "matrix-summary.json"), "utf8"));
    assert.equal(matrix.results.length, 3);
    const bcp = matrix.results.find((result) => result.configId === "billion-context-pi");
    assert.equal(bcp.benchmarkMode, "billion-context-pi");
    assert.equal(bcp.metrics.committedBlocks, 3);
    assert.deepEqual(bcp.metrics.committedBlocksByTier, { "1": 1, "2": 1, "3": 1 });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("logs provider-measured context on the prompt step continued after native compaction", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "big-pi-compaction-context-test-"));
  try {
    const promptsPath = path.join(temp, "prompts.json");
    const runsDir = path.join(temp, "runs");
    await writeFile(promptsPath, JSON.stringify({ prompts: [
      { id: "step-one", text: "one" },
      { id: "step-two", text: "two" },
      { id: "step-three", text: "three" },
      { id: "step-four", text: "four" },
    ] }));
    const invocation = spawnSync(process.execPath, [
      path.join(root, "benchmarks", "benchmark.mjs"),
      "--prompts", promptsPath,
      "--stock-pi",
      "--pi", process.execPath,
      "--pi-arg", path.join(root, "test", "fake-pi.mjs"),
      "--pi-arg", "--test-post-compaction-context",
      "--pi-arg", "--test-distinct-prompt-usage",
      "--runs-dir", runsDir,
      "--projects-dir", path.join(temp, "projects"),
    ], { encoding: "utf8", timeout: 30_000 });
    if (invocation.error?.code === "EPERM") {
      t.skip("This sandbox blocks Node.js child processes; run this integration check on the target machine.");
      return;
    }
    assert.equal(invocation.status, 0, invocation.stdout + invocation.stderr);
    assert.match(invocation.stdout, /Pi compaction ended in .*s/);
    for (let step = 1; step <= 4; step++) {
      const id = ["step-one", "step-two", "step-three", "step-four"][step - 1];
      const expectedTokens = 80 + step;
      const stepLines = invocation.stdout.split("\n").filter((line) => line.includes(`[${step}/4] ${id}`));
      const sendingLine = stepLines.find((line) => line.includes(" sending "));
      const measuredLine = stepLines.find((line) => line.includes("initial request context measured"));
      const settledLine = stepLines.find((line) => line.includes("settled:"));
      assert.ok(sendingLine && measuredLine && settledLine, `step ${step} must have sending, measured, and settled lines`);
      assert.ok(measuredLine.includes(String(expectedTokens)) && measuredLine.includes("1,000 tokens"), `step ${step} must report its own measured prompt count`);
      assert.equal(sendingLine.indexOf("sending"), measuredLine.indexOf("initial request context measured"));
      assert.equal(sendingLine.indexOf("sending"), settledLine.indexOf("settled:"));
    }
    assert.match(invocation.stdout, /\[4\/4\] step-four continued after Pi compaction.*context \[\s*62 \/\s*1,000 tokens \]/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("config-set mode records a failed case and continues to the next configuration", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "big-pi-benchmark-matrix-test-"));
  const promptsPath = path.join(temp, "prompts.json");
  const invalidConfigPath = path.join(temp, "invalid.json");
  const configSetPath = path.join(temp, "matrix.json");
  const extensionPath = path.join(temp, "unused-extension.js");
  const runsDir = path.join(temp, "runs");
  const projectsDir = path.join(temp, "projects");
  await writeFile(promptsPath, JSON.stringify(["fixed prompt"]));
  await writeFile(invalidConfigPath, "{ this is invalid JSON\n");
  await writeFile(extensionPath, "// fake extension entry\n");
  await writeFile(configSetPath, JSON.stringify({
    name: "failure-test",
    targetContextWindowTokens: 80000,
    configurations: [
      { id: "bad-config", configFile: "invalid.json" },
      { id: "good-config", config: { nudge: { mode: "growth", growthTriggerTokens: 20000 } } },
    ],
  }));
  const invocation = spawnSync(process.execPath, [
    path.join(root, "benchmarks", "benchmark.mjs"),
    "--prompts", promptsPath,
    "--extension", extensionPath,
    "--config-set", configSetPath, "--include-stock",
    "--pi", process.execPath,
    "--pi-arg", path.join(root, "test", "fake-pi.mjs"),
    "--runs-dir", runsDir,
    "--projects-dir", projectsDir,
  ], { encoding: "utf8", timeout: 120_000 });
  try {
    if (invocation.error?.code === "EPERM") {
      t.skip("This sandbox blocks Node.js child processes; run this integration check on the target machine.");
      return;
    }
    assert.equal(invocation.status, 1, `${invocation.stdout}\n${invocation.stderr}`);
    assert.match(invocation.stderr, /Config bad-config failed before the Pi run: Invalid Big Pi config JSON/);
    assert.doesNotMatch(invocation.stdout, /Run 1\/1 \[bad-config\]/);
    assert.match(invocation.stdout, /Run 1\/1 \[good-config\]/);
    const matrix = JSON.parse(await readFile(path.join(runsDir, "matrix-summary.json"), "utf8"));
    assert.equal(matrix.targetContextWindowTokens, 80000);
    assert.equal(matrix.expectedRuns, 3);
    assert.equal(matrix.completedRuns, 3);
    assert.deepEqual(matrix.results.map((result) => result.status), ["failed", "completed", "completed"]);
    assert.equal(matrix.results[1].metrics.committedBlocks, 3);
    assert.equal(matrix.results[1].metrics.committedBlocksByTier["2"], 1);
    assert.equal(matrix.results[1].metrics.peakContextTokens, 100);
    assert.ok(matrix.results[1].metrics.promptTimeMs > 0);
    const failed = JSON.parse(await readFile(matrix.results[0].summaryPath, "utf8"));
    assert.match(failed.completion.failure.message, /Invalid Big Pi config JSON/);
    const completed = JSON.parse(await readFile(matrix.results[1].summaryPath, "utf8"));
    assert.equal(completed.configId, "good-config");
    assert.equal(completed.targetContextWindowTokens, 80000);
    assert.equal(completed.completion.completedPrompts, 1);
    assert.equal(path.dirname(completed.projectDir), projectsDir);
    assert.equal(await readFile(completed.artifacts.bigPiLogFile, "utf8"), "fake Big Pi development log\n");
    assert.deepEqual(await readdir(completed.artifacts.bigPiContextDumpsDir), ["fake-context-dump.txt"]);
    const stock = matrix.results[2];
    assert.equal(stock.configId, "stock-pi");
    assert.equal(stock.benchmarkMode, "stock-pi");
    assert.equal(stock.metrics.committedBlocks, 0);
    const stockSummary = JSON.parse(await readFile(stock.summaryPath, "utf8"));
    const stockLaunch = JSON.parse(await readFile(path.join(stockSummary.sessionDir, "fake-launch-info.json"), "utf8"));
    assert.equal(stockSummary.extensionPath, null);
    assert.equal(stockLaunch.args.includes("--extension"), false);
    assert.deepEqual(stockLaunch.bigPiEnvironment, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


test("step columns align and settled cannot bypass queued compaction recovery", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "big-pi-readiness-test-"));
  try {
    const promptsPath = path.join(temp, "prompts.json");
    await writeFile(promptsPath, JSON.stringify(Array.from({ length: 20 }, (_, index) => ({ id: `step-${index + 1}`, text: "work" }))));
    const invocation = spawnSync(process.execPath, [
      path.join(root, "benchmarks", "benchmark.mjs"), "--prompts", promptsPath,
      "--extension", path.join(temp, "unused.js"), "--pi", process.execPath,
      "--pi-arg", path.join(root, "test", "fake-pi.mjs"), "--pi-arg", "--test-recovery-readiness",
      "--runs-dir", path.join(temp, "runs"), "--projects-dir", path.join(temp, "projects"),
    ], { encoding: "utf8", timeout: 20000 });
    if (invocation.error?.code === "EPERM") {
      t.skip("This sandbox blocks Node.js child processes; run this integration check on the target machine.");
      return;
    }
    assert.equal(invocation.status, 0, invocation.stdout + invocation.stderr);
    assert.ok(invocation.stdout.includes("[ 1/20] step-1"));
    assert.ok(invocation.stdout.includes("[10/20] step-10"));
    const lines = invocation.stdout.split("\n").filter((line) => /step-.*sending/.test(line));
    assert.equal(new Set(lines.map((line) => line.indexOf("sending"))).size, 1);
    assert.equal(invocation.stdout.match(/Pi compaction cancelled/g)?.length, 1);
    const [run] = await readdir(path.join(temp, "runs"));
    const summary = JSON.parse(await readFile(path.join(temp, "runs", run, "summary.json"), "utf8"));
    assert.equal(summary.completion.completedPrompts, 20);
    assert.equal(summary.piCompactions.cancelledCount, 60);
    assert.ok(summary.prompts.every((prompt) => prompt.durationMs >= 150));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("unrecovered Pi compaction errors are settled but not successful prompt completions", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "big-pi-compaction-failure-test-"));
  try {
    const promptsPath = path.join(temp, "prompts.json");
    await writeFile(promptsPath, JSON.stringify([{ id: "overflow", text: "work" }]));
    const invocation = spawnSync(process.execPath, [
      path.join(root, "benchmarks", "benchmark.mjs"), "--prompts", promptsPath,
      "--extension", path.join(temp, "unused.js"), "--pi", process.execPath,
      "--pi-arg", path.join(root, "test", "fake-pi.mjs"), "--pi-arg", "--test-compaction-failure",
      "--runs-dir", path.join(temp, "runs"), "--projects-dir", path.join(temp, "projects"),
    ], { encoding: "utf8", timeout: 20000 });
    if (invocation.error?.code === "EPERM") {
      t.skip("This sandbox blocks Node.js child processes; run this integration check on the target machine.");
      return;
    }
    assert.equal(invocation.status, 1, invocation.stdout + invocation.stderr);
    assert.match(invocation.stdout, /settled: .* \(Pi compaction failed: 1\)/);
    assert.match(invocation.stdout, /Prompts completed 0\/1 \(1 settled; 1 with Pi compaction errors\)/);
    const [run] = await readdir(path.join(temp, "runs"));
    const summary = JSON.parse(await readFile(path.join(temp, "runs", run, "summary.json"), "utf8"));
    assert.equal(summary.completion.completedPrompts, 0);
    assert.equal(summary.completion.settledPrompts, 1);
    assert.equal(summary.completion.promptFailures[0].code, "PI_COMPACTION_FAILED");
    assert.match(summary.completion.promptFailures[0].message, /Context overflow recovery failed/);
    assert.equal(summary.prompts[0].settled, true);
    assert.equal(summary.prompts[0].completed, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("--resume preserves finished entries and replaces the interrupted run and project", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "big-pi-resume-test-"));
  try {
    const promptsPath = path.join(temp, "prompts.json");
    const configSetPath = path.join(temp, "matrix.json");
    const extensionPath = path.join(temp, "unused.js");
    const runsDir = path.join(temp, "runs");
    const projectsDir = path.join(temp, "projects");
    await writeFile(promptsPath, JSON.stringify([{ id: "one", text: "work" }]));
    await writeFile(extensionPath, "// fixture\n");
    await writeFile(configSetPath, JSON.stringify({ name: "resume-test", configurations: [
      { id: "first", config: { nudge: { mode: "growth", growthTriggerTokens: 20000 } } },
      { id: "second", config: { nudge: { mode: "percentage", thresholdPercentage: 70 } } },
    ] }));
    const args = [path.join(root, "benchmarks", "benchmark.mjs"), "--prompts", promptsPath,
      "--extension", extensionPath, "--config-set", configSetPath,
      "--pi", process.execPath, "--pi-arg", path.join(root, "test", "fake-pi.mjs"),
      "--runs-dir", runsDir, "--projects-dir", projectsDir];
    const firstRun = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30000 });
    if (firstRun.error?.code === "EPERM") {
      t.skip("This sandbox blocks Node.js child processes; run this integration check on the target machine.");
      return;
    }
    assert.equal(firstRun.status, 0, firstRun.stdout + firstRun.stderr);
    const matrixPath = path.join(runsDir, "matrix-summary.json");
    const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
    assert.deepEqual(matrix.results.map((item) => item.status), ["completed", "completed"]);
    const preserved = matrix.results[0];
    const partial = matrix.results[1];
    await writeFile(path.join(partial.runDir, "partial-marker"), "remove me");
    await writeFile(path.join(partial.projectDir, "partial-marker"), "remove me");
    const runStatePath = path.join(partial.runDir, "run-state.json");
    const runState = JSON.parse(await readFile(runStatePath, "utf8"));
    runState.status = "interrupted";
    await writeFile(runStatePath, `${JSON.stringify(runState, null, 2)}\n`);
    matrix.results[1].status = "interrupted";
    await writeFile(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);

    const resumed = spawnSync(process.execPath, [...args, "--resume"], { encoding: "utf8", timeout: 30000 });
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.match(resumed.stdout, /Resuming resume-test: keeping 1 finished run/);
    const finalMatrix = JSON.parse(await readFile(matrixPath, "utf8"));
    assert.equal(finalMatrix.results.length, 2);
    assert.equal(finalMatrix.results[0].runDir, preserved.runDir);
    assert.equal(finalMatrix.results[0].projectDir, preserved.projectDir);
    assert.equal(finalMatrix.results[1].status, "completed");
    assert.notEqual(finalMatrix.results[1].runDir, partial.runDir);
    assert.notEqual(finalMatrix.results[1].projectDir, partial.projectDir);
    await assert.rejects(readFile(path.join(partial.runDir, "partial-marker")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(partial.projectDir, "partial-marker")), { code: "ENOENT" });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
