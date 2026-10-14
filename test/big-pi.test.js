import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bigPi, { deleteBigPiAgentData as deleteAgentDataFromExtension } from "../index.js";
import {
  DEFAULTS,
  ProjectionError,
  StateIntegrityError,
  applicableCoveredRefs,
  applyCompression,
  bindContextMessages,
  computeProtectedRefs,
  calculateEmergencyPressure,
  calibrateContextEstimate,
  createBlock,
  createHierarchicalBlock,
  createEmptyState,
  createLogger,
  appendSessionDebugEvent,
  agentStorageFolderPath,
  agentStorageRootPath,
  deleteAllBigPiAgentData,
  deleteBigPiAgentData,
  ensurePercentageCadence,
  ensureMessageReferences,
  estimateTokens,
  getBlockApplicability,
  getEffectiveOriginalRefs,
  minimumSummaryTokens,
  loadConfig,
  messageText,
  persistState,
  parseProviderContextWindow,
  recordPercentageNudge,
  readState,
  renderContextDump,
  sidecarPath,
  sessionDebugLogPath,
  storageDiskUsage,
  storageFolderPath,
  transformContext,
  updateMetrics,
  validateSelectedRange,
  validateSummaryRetention,
} from "../lib/big-pi.js";

test("calibrates effective context from recent provider usage plus projected deltas", () => {
  assert.equal(calibrateContextEstimate(12_000, 10_500, 10_000), 12_500);
  assert.equal(calibrateContextEstimate(8_000, 10_500, 10_000), 8_500);
  assert.equal(calibrateContextEstimate(12_000, 0, 10_000), 2_000);
  assert.equal(calibrateContextEstimate(-1, 10_500, 10_000), -1);
});

test("parses explicit provider context-window limits without matching unrelated errors", () => {
  assert.equal(parseProviderContextWindow("prompt is too long: 90,000 tokens > 80,000 maximum"), 80_000);
  assert.equal(parseProviderContextWindow("maximum context length is 128000 tokens"), 128_000);
  assert.equal(parseProviderContextWindow("invalid API key; request was rejected"), null);
  assert.equal(parseProviderContextWindow("maximum context length is 999 tokens"), null);
});

function textMessage(role, text) {
  return { role, content: [{ type: "text", text }] };
}

function fixtureProjection(count = 8, options = {}) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (options.stateOnly && i === 3) {
      entries.push({
        sourceEntry: { type: "custom", id: "state-only-1", parentId: entries.at(-1)?.sourceEntry.id },
        messages: [],
      });
    }
    const role = i === 0 || i === count - 1 ? "user" : i % 2 ? "assistant" : "toolResult";
    const message = textMessage(role, `message-${i}: ${"x".repeat(options.messageChars ?? 80)}`);
    const sourceEntry = {
      type: "message",
      id: `${options.prefix ?? "entry"}-${i}`,
      parentId: entries.at(-1)?.sourceEntry.id ?? null,
      timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      message,
    };
    entries.push({ sourceEntry, messages: [message] });
  }
  return { entries, messages: entries.flatMap((entry) => entry.messages) };
}

function toolExchangeProjection(options = {}) {
  const entries = [];
  const append = (id, message) => {
    const sourceEntry = {
      type: "message",
      id,
      parentId: entries.at(-1)?.sourceEntry.id ?? null,
      message,
    };
    entries.push({ sourceEntry, messages: [message] });
  };
  append("tool-root-user", textMessage("user", "Request."));
  append("tool-assistant-calls", {
    role: "assistant",
    content: [
      { type: "text", text: "I will inspect two files." },
      { type: "toolCall", id: "call-alpha", name: "read", arguments: { path: "/alpha", payload: "a".repeat(options.toolChars ?? 500) } },
      { type: "toolCall", id: "call-beta", name: "read", arguments: { path: "/beta", payload: "b".repeat(options.toolChars ?? 500) } },
    ],
  });
  const resultEntries = [
    ["alpha", "call-alpha", "a"],
    ["beta", "call-beta", "b"],
  ];
  if (options.lastResultId) {
    resultEntries.sort((left, right) => Number(left[1] === options.lastResultId) - Number(right[1] === options.lastResultId));
  }
  for (const [name, toolCallId, marker] of resultEntries) {
    append(`tool-result-${name}`, {
      role: "toolResult",
      toolCallId,
      toolName: "read",
      content: [{ type: "text", text: `${name} result ${marker.repeat(options.resultChars ?? 500)}` }],
      isError: false,
    });
  }
  if (!options.finalResultLast) {
    append("tool-assistant-followup", textMessage("assistant", "I compared the results."));
  }
  if (options.finalUser !== false) append("tool-latest-user", textMessage("user", "Continue."));
  return { entries, messages: entries.flatMap((entry) => entry.messages) };
}

function branchProjection(branch, messageChars = 300) {
  const entries = [];
  const append = (id, role, text, type = "message") => {
    const sourceEntry = { id, parentId: entries.at(-1)?.sourceEntry.id ?? null, type };
    const messages = role ? [textMessage(role, text)] : [];
    entries.push({ sourceEntry, messages });
  };
  append("root-user", "user", `root ${"r".repeat(20)}`);
  for (let i = 1; i <= 6; i++) {
    if (i === 3) append(`${branch}-state`, null, "", "custom");
    append(`${branch}-${i}`, i % 2 ? "assistant" : "toolResult", `${branch}-${i} ${"q".repeat(messageChars)}`);
  }
  append(`${branch}-leaf-user`, "user", "latest user request");
  return { entries, messages: entries.flatMap((entry) => entry.messages) };
}

function sessionTree(projections) {
  const entriesById = new Map();
  for (const projection of projections) {
    for (const projectedEntry of projection.entries) {
      const entry = projectedEntry.sourceEntry;
      if (!entriesById.has(entry.id)) entriesById.set(entry.id, entry);
    }
  }
  const nodes = new Map([...entriesById].map(([id, entry]) => [id, { entry, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.entry.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (items) => {
    items.sort((left, right) =>
      String(left.entry.timestamp ?? "").localeCompare(String(right.entry.timestamp ?? "")) ||
      String(left.entry.id).localeCompare(String(right.entry.id))
    );
    for (const node of items) sort(node.children);
  };
  sort(roots);
  return roots;
}

let activeHarness;

function extensionHarness(directory, getProjection, options = {}) {
  const sessionPath = path.join(directory, "session.jsonl");
  const configPath = path.join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({
    growthTriggerTokens: options.growthTriggerTokens ?? 1000,
    ...(options.nudge ? { nudge: options.nudge } : {}),
    ...(options.hierarchy ? { hierarchy: options.hierarchy } : {}),
    emergency: options.emergency ?? { enabled: false },
    minCompressRangeChars: options.minCompressRangeChars ?? 100,
    minSummaryRetentionPercent: options.minSummaryRetentionPercent ?? 0,
    protectedRecentMessages: options.protectedRecentMessages ?? 1,
    protectedRecentTokens: 0,
  }));
  const previousConfig = process.env.BIG_PI_CONFIG;
  process.env.BIG_PI_CONFIG = configPath;
  const handlers = new Map();
  const handlerRegistrations = new Map();
  const commands = new Map();
  const tools = new Map();
  const sentMessages = [];
  const notices = [];
  let providerUsageExplicit = false;
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendUserMessage(message, delivery) { sentMessages.push({ message, delivery }); },
    on(name, handler) {
      const wrapped = ["before_agent_start", "context"].includes(name)
        ? (event, eventCtx) => {
          if (!providerUsageExplicit) {
            const usage = eventCtx.getContextUsage?.();
            if (Number.isSafeInteger(usage?.tokens) && usage.tokens > 0) {
              handlers.get("turn_end")?.({
                message: { role: "assistant", usage: { input: usage.tokens, cacheRead: 0, cacheWrite: 0 } },
              }, eventCtx);
            }
          }
          return handler(event, eventCtx);
        }
        : handler;
      handlers.set(name, wrapped);
      const registrations = handlerRegistrations.get(name) ?? [];
      registrations.push(handler);
      handlerRegistrations.set(name, registrations);
    },
  };
  const ctx = {
    sessionManager: {
      getSessionFile: () => options.getSessionPath ? options.getSessionPath() : sessionPath,
      getSessionId: () => "growth-test-session",
      buildSessionProjection: getProjection,
      getTree: () => options.getTree?.() ?? [],
      getBranch: () => options.getBranch?.() ?? [],
    },
    getContextUsage: () => Object.hasOwn(options, "getContextUsage")
      ? options.getContextUsage()
      : { tokens: 800, contextWindow: 12000, percent: 0.07 },
    model: options.model,
    ui: { notify(message) { notices.push(message); } },
  };
  bigPi(pi);
  const harness = {
    commands,
    ctx,
    handlers,
    handlerRegistrations,
    notices,
    previousConfig,
    sentMessages,
    sessionPath,
    tools,
    setProviderUsageExplicit() { providerUsageExplicit = true; },
  };
  activeHarness = harness;
  return harness;
}

function windowForUsage(projection, usedPercentage) {
  return Math.floor(estimateTokens(projection.messages) * 100 / usedPercentage);
}

function setProjectionGrowth(projection, baselineTokens, growthTokens, entryId = "growth-message", state) {
  let entry = projection.entries.find((item) => item.sourceEntry.id === entryId);
  let message;
  if (!entry) {
    message = textMessage("toolResult", "growth:");
    entry = {
      sourceEntry: {
        type: "message",
        id: entryId,
        parentId: projection.entries.at(-1)?.sourceEntry.id ?? null,
        timestamp: "2026-01-02T00:00:00.000Z",
      },
      messages: [message],
    };
    projection.entries.push(entry);
    projection.messages.push(message);
  } else {
    message = entry.messages[0];
  }
  const original = "growth:";
  let low = 0;
  let high = Math.max(100, growthTokens * 4 + 100);
  const setLength = (length) => {
    message.content[0].text = original + "g".repeat(length);
  };
  const growthAt = (length) => {
    setLength(length);
    if (!state) return estimateTokens(projection.messages) - baselineTokens;
    const bindings = ensureMessageReferences(state, projection);
    const transformed = transformContext(projection.messages, bindings, state.blocks);
    return estimateTokens(transformed) - baselineTokens;
  };
  while (growthAt(high) < growthTokens) high *= 2;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (growthAt(middle) < growthTokens) low = middle + 1;
    else high = middle;
  }
  assert.equal(growthAt(low), growthTokens, "estimator fixture should reach requested growth exactly");
  projection.messages = projection.entries.flatMap((item) => item.messages);
  if (activeHarness) {
    // Tests that construct a synthetic context delta also provide matching
    // provider usage events; the extension itself never infers these counts.
    const statePath = sidecarPath(activeHarness.sessionPath);
    const saved = readState(statePath, activeHarness.sessionPath).state;
    const cadence = saved.compression.growth.projections[saved.metrics.growthProjectionId];
    let providerBaseline = cadence?.baselineEffectiveTokens ?? saved.metrics.piContextUsageTokens;
    if (saved.metrics.piContextUsageTokens === null) {
      reportProviderUsage(activeHarness, baselineTokens);
      activeHarness.handlers.get("before_agent_start")({ systemPrompt: "" }, activeHarness.ctx);
      providerBaseline = baselineTokens;
    }
    reportProviderUsage(activeHarness, providerBaseline + growthTokens);
  }
}

function setProjectionEffectiveTokens(projection, targetTokens, entryId = "percentage-message", state) {
  const baselineTokens = estimateTokens(projection.messages);
  assert.equal(targetTokens >= baselineTokens, true, `fixture target ${targetTokens} must not shrink ${baselineTokens} tokens`);
  setProjectionGrowth(projection, baselineTokens, targetTokens - baselineTokens, entryId, state);
  if (activeHarness) reportProviderUsage(activeHarness, targetTokens);
}

function reportProviderUsage(harness, promptTokens) {
  harness.setProviderUsageExplicit();
  harness.handlers.get("turn_end")({
    message: { role: "assistant", usage: { input: promptTokens, cacheRead: 0, cacheWrite: 0 } },
  }, harness.ctx);
}

function restoreHarnessConfig(harness) {
  if (harness.previousConfig === undefined) delete process.env.BIG_PI_CONFIG;
  else process.env.BIG_PI_CONFIG = harness.previousConfig;
}

function protectedRefs(bindings, options = {}) {
  return computeProtectedRefs(bindings, {
    protectedRecentMessages: options.protectedRecentMessages ?? 0,
    protectedRecentTokens: options.protectedRecentTokens ?? 0,
  }).refs;
}

function createTier1Blocks(state, projection, bindings, count = 3, groupSize = 3) {
  const blocks = [];
  const firstSource = 1;
  for (let index = 0; index < count; index++) {
    const start = firstSource + index * groupSize;
    const end = start + groupSize - 1;
    blocks.push(applyCompression(
      state,
      bindings,
      protectedRefs(bindings),
      bindings[start].ref,
      bindings[end].ref,
      `Phase ${index + 1}: preserve the durable implementation decisions, current state, unresolved requirements, and verified tests for this completed work period.`,
      100,
    ));
  }
  return blocks;
}

test("configuration defaults, file/environment overrides, and invalid values", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-config-"));
  try {
    const configPath = path.join(directory, "config.json");
    const defaultConfig = loadConfig({
      BIG_PI_CONFIG: path.join(directory, "missing.json"),
    }).config;
    assert.equal(defaultConfig.growthTriggerTokens, 50000);
    assert.equal(DEFAULTS.growthTriggerTokens, 50000);
    assert.deepEqual(defaultConfig.nudge, {
      mode: "percentage",
      growthTriggerTokens: 50000,
      thresholdPercentage: 75,
      repeatEveryPercentage: 5,
      display: "used",
    });
    assert.deepEqual(defaultConfig.hierarchy, {
      enabled: true,
      minBlocksPerPromotion: 3,
      tier2NudgeSummaryTokens: 20000,
      tier3NudgeSummaryTokens: 20000,
    });
    writeFileSync(configPath, JSON.stringify({
      growthTriggerTokens: 1000,
      minCompressRangeChars: 200,
      debug: false,
      protectedRecentMessages: 3,
    }));
    const warnings = [];
    const { config } = loadConfig({
      BIG_PI_CONFIG: configPath,
      BIG_PI_GROWTH_TRIGGER_TOKENS: "2000",
      BIG_PI_MIN_COMPRESS_RANGE_CHARS: "25",
      BIG_PI_DEBUG: "true",
    }, (warning) => warnings.push(warning));
    assert.equal(config.growthTriggerTokens, 2000);
    assert.equal(config.minCompressRangeChars, 25);
    assert.equal(config.debug, true);
    assert.equal(config.protectedRecentMessages, 3);
    assert.equal(config.protectedRecentTokens, DEFAULTS.protectedRecentTokens);
    assert.equal(warnings.length, 0);

    const invalid = loadConfig({
      BIG_PI_CONFIG: configPath,
      BIG_PI_GROWTH_TRIGGER_TOKENS: "-1",
      BIG_PI_MIN_COMPRESS_RANGE_CHARS: "0",
      BIG_PI_DEBUG: "perhaps",
    }, (message) => warnings.push(message)).config;
    assert.equal(invalid.growthTriggerTokens, 1000);
    assert.equal(invalid.minCompressRangeChars, 200);
    assert.equal(invalid.debug, false);
    assert.equal(warnings.length, 3);
    assert.equal(DEFAULTS.minCompressRangeChars, 5000);
    assert.equal(DEFAULTS.minSummaryRetentionPercent, 2);

    const invalidFilePath = path.join(directory, "invalid-config.json");
    writeFileSync(invalidFilePath, JSON.stringify({ growthTriggerTokens: 0 }));
    const invalidFileWarnings = [];
    const invalidFileConfig = loadConfig({
      BIG_PI_CONFIG: invalidFilePath,
    }, (message) => invalidFileWarnings.push(message)).config;
    assert.equal(invalidFileConfig.growthTriggerTokens, 50000);
    assert.equal(invalidFileWarnings.some((message) => message.includes("growthTriggerTokens")), true);

    writeFileSync(configPath, JSON.stringify({
      growthTriggerTokens: 900,
      nudge: {
        mode: "percentage",
        growthTriggerTokens: 1200,
        thresholdPercentage: 65,
        repeatEveryPercentage: 5,
        display: "remaining",
      },
    }));
    const configured = loadConfig({ BIG_PI_CONFIG: configPath }).config;
    assert.deepEqual(configured.nudge, {
      mode: "percentage",
      growthTriggerTokens: 1200,
      thresholdPercentage: 65,
      repeatEveryPercentage: 5,
      display: "remaining",
    });
    const envOverride = loadConfig({
      BIG_PI_CONFIG: configPath,
      BIG_PI_GROWTH_TRIGGER_TOKENS: "2000",
      BIG_PI_NUDGE_MODE: "hybrid",
      BIG_PI_NUDGE_THRESHOLD_PERCENTAGE: "72.5",
      BIG_PI_NUDGE_REPEAT_PERCENTAGE: "7.5",
      BIG_PI_NUDGE_DISPLAY: "used",
    }).config;
    assert.deepEqual(envOverride.nudge, {
      mode: "hybrid",
      growthTriggerTokens: 2000,
      thresholdPercentage: 72.5,
      repeatEveryPercentage: 7.5,
      display: "used",
    });
    writeFileSync(configPath, JSON.stringify({
      nudge: {
        mode: "unknown",
        growthTriggerTokens: 0,
        thresholdPercentage: 101,
        repeatEveryPercentage: 0,
        display: "sideways",
      },
    }));
    const invalidNudgeWarnings = [];
    const invalidNudge = loadConfig({
      BIG_PI_CONFIG: configPath,
      BIG_PI_NUDGE_MODE: "unknown",
      BIG_PI_NUDGE_THRESHOLD_PERCENTAGE: "-1",
      BIG_PI_NUDGE_REPEAT_PERCENTAGE: "101",
      BIG_PI_NUDGE_DISPLAY: "unknown",
    }, (message) => invalidNudgeWarnings.push(message)).config;
    assert.deepEqual(invalidNudge.nudge, {
      mode: "percentage",
      growthTriggerTokens: 50000,
      thresholdPercentage: 75,
      repeatEveryPercentage: 5,
      display: "used",
    });
    assert.equal(invalidNudgeWarnings.length, 9);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("per-session debug events require BIG_PI_DEBUG and retain concise event history", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-debug-log-"));
  const sessionPath = path.join(directory, "session.jsonl");
  const logPath = sessionDebugLogPath(sessionPath);
  try {
    appendSessionDebugEvent(sessionPath, "disabled", {}, {});
    assert.equal(existsSync(logPath), false);
    appendSessionDebugEvent(sessionPath, "enabled", { attempt: 1 }, { BIG_PI_DEBUG: "TRUE" });
    assert.equal(JSON.parse(readFileSync(logPath, "utf8").trim()).event, "enabled");
    for (let index = 0; index < 2_000; index++) {
      appendSessionDebugEvent(sessionPath, "event", { index }, { BIG_PI_DEBUG: "1" });
    }
    const contents = readFileSync(logPath, "utf8");
    assert.ok(Buffer.byteLength(contents) > 64 * 1024);
    assert.match(contents, /"index":0\}/);
    assert.match(contents, /"index":1999\}/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("agent IDs isolate Big Pi storage/debug data and expose safe cleanup helpers", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-agent-isolation-"));
  try {
    const sessionPath = path.join(directory, "session.jsonl");
    const agentA = "extension-one/subagent:α";
    const agentB = "extension-two/subagent:α";
    const folderA = agentStorageFolderPath(sessionPath, agentA);
    const folderB = agentStorageFolderPath(sessionPath, agentB);
    assert.notEqual(folderA, folderB);
    assert.equal(deleteAgentDataFromExtension, deleteBigPiAgentData);
    assert.ok(folderA.startsWith(`${agentStorageRootPath(sessionPath)}${path.sep}`));
    assert.equal(storageFolderPath(sessionPath), `${sessionPath}.big-pi`);

    appendSessionDebugEvent(sessionPath, "agent_event", { safe: true }, { BIG_PI_DEBUG: "true" }, agentA);
    assert.equal(readFileSync(path.join(folderA, "debug.jsonl"), "utf8").includes('"event":"agent_event"'), true);
    assert.equal(sessionDebugLogPath(sessionPath, agentA), path.join(folderA, "debug.jsonl"));

    mkdirSync(path.join(folderA, "blocks"), { recursive: true });
    writeFileSync(path.join(folderA, "manifest.json"), "agent A");
    mkdirSync(folderB, { recursive: true });
    writeFileSync(path.join(folderB, "manifest.json"), "agent B");
    assert.equal(deleteBigPiAgentData(sessionPath, agentA), true);
    assert.equal(existsSync(folderA), false);
    assert.equal(readFileSync(path.join(folderB, "manifest.json"), "utf8"), "agent B");
    assert.equal(deleteBigPiAgentData(sessionPath, agentA), false);
    assert.equal(deleteAllBigPiAgentData(sessionPath), true);
    assert.equal(existsSync(agentStorageRootPath(sessionPath)), false);
    assert.equal(deleteAllBigPiAgentData(sessionPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("summary retention floor rejects extreme compression while allowing disabled guard", () => {
  assert.equal(minimumSummaryTokens(10000, 2), 200);
  assert.equal(minimumSummaryTokens(1000, 2), 64);
  assert.equal(minimumSummaryTokens(10000, 0), 0);
  assert.throws(() => validateSummaryRetention("222 tokens", 22546, 2), /minimum 451 tokens/);
  assert.doesNotThrow(() => validateSummaryRetention("222 tokens", 22546, 0));
});

test("emergency config validates defaults, environment precedence, and safe fallback", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-emergency-config-"));
  try {
    const configPath = path.join(directory, "config.json");
    const defaults = loadConfig({ BIG_PI_CONFIG: path.join(directory, "missing.json") }).config;
    assert.deepEqual(defaults.emergency, {
      enabled: true,
      pressureThresholdPercentage: 85,
      targetPercentageAfterCompression: 70,
      maxAttemptsPerTurn: 2,
    });

    writeFileSync(configPath, JSON.stringify({
      emergency: {
        enabled: false,
        pressureThresholdPercentage: 88,
        targetPercentageAfterCompression: 65,
        maxAttemptsPerTurn: 3,
      },
    }));
    assert.deepEqual(loadConfig({
      BIG_PI_CONFIG: configPath,
      BIG_PI_EMERGENCY_ENABLED: "true",
      BIG_PI_PRESSURE_THRESHOLD_PERCENTAGE: "92.5",
      BIG_PI_TARGET_PERCENTAGE: "68",
      BIG_PI_MAX_EMERGENCY_ATTEMPTS: "4",
    }).config.emergency, {
      enabled: true,
      pressureThresholdPercentage: 92.5,
      targetPercentageAfterCompression: 68,
      maxAttemptsPerTurn: 4,
    });

    writeFileSync(configPath, JSON.stringify({
      emergency: {
        pressureThresholdPercentage: 80,
        targetPercentageAfterCompression: 80,
        maxAttemptsPerTurn: 6,
      },
    }));
    const warnings = [];
    const invalid = loadConfig({ BIG_PI_CONFIG: configPath }, (warning) => warnings.push(warning)).config;
    assert.deepEqual(invalid.emergency, defaults.emergency);
    assert.equal(warnings.length, 2);

    writeFileSync(configPath, JSON.stringify({ emergencyContextUtilization: 0.85 }));
    assert.equal(loadConfig({ BIG_PI_CONFIG: configPath }).config.emergency.pressureThresholdPercentage, 85);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("emergency pressure boundaries, negative remaining, and reclaim target are unclamped", () => {
  const config = {
    pressureThresholdPercentage: 90,
    targetPercentageAfterCompression: 70,
  };
  assert.equal(calculateEmergencyPressure(89000, 100000, config).pressure, false);
  assert.equal(calculateEmergencyPressure(90000, 100000, config).pressure, true);
  assert.equal(calculateEmergencyPressure(95000, 100000, config).pressure, true);
  const pressure = calculateEmergencyPressure(192000, 200000, config);
  assert.equal(pressure.targetEffectiveTokens, 140000);
  assert.equal(pressure.estimatedReclaimTokens, 52000);
  const over = calculateEmergencyPressure(214000, 200000, config);
  assert.equal(over.usedPercentage, 107);
  assert.equal(over.remainingPercentage, -7);
  assert.equal(over.overBudgetTokens, 14000);
  assert.equal(over.targetEffectiveTokens, 140000);
  assert.equal(over.estimatedReclaimTokens, 74000);
  assert.equal(calculateEmergencyPressure(214000, null, config).usedPercentage, null);
  assert.equal(calculateEmergencyPressure(214000, null, config).estimatedReclaimTokens, null);
});

test("percentage checkpoints are discrete, exact at boundaries, and continue above 100%", () => {
  const state = createEmptyState("/session.jsonl");
  const projectionId = "a".repeat(64);
  const observe = (effectiveTokens, contextWindow = 100) => ensurePercentageCadence(
    state,
    projectionId,
    effectiveTokens,
    contextWindow,
    70,
    10,
  );
  const deliver = (effectiveTokens, expectedCheckpoint) => {
    const result = observe(effectiveTokens);
    assert.equal(result.percentageNudgeDue, true);
    assert.equal(result.dueCheckpointPercentage, expectedCheckpoint);
    recordPercentageNudge(
      state,
      projectionId,
      result.dueCheckpointPercentage,
    );
  };

  assert.equal(observe(69).percentageNudgeDue, false);
  assert.equal(observe(69_999_999, 100_000_000).percentageNudgeDue, false);
  deliver(70, 70);
  assert.equal(observe(71).percentageNudgeDue, false);
  assert.equal(observe(79).percentageNudgeDue, false);
  deliver(80, 80);
  assert.equal(observe(89).percentageNudgeDue, false);
  deliver(90, 90);
  deliver(100, 100);
  assert.equal(observe(107).percentageNudgeDue, false);
  deliver(110, 110);
  deliver(120, 120);
  assert.equal(state.compression.percentage.projections[projectionId].nextCheckpointPercentage, 130);
});

test("percentage diagnostics preserve over-budget values and deterministic re-arming", () => {
  const state = createEmptyState("/session.jsonl");
  const projectionId = "b".repeat(64);
  const observe = (effectiveTokens, contextWindow = 100) => ensurePercentageCadence(
    state,
    projectionId,
    effectiveTokens,
    contextWindow,
    70,
    10,
  );
  for (const checkpoint of [70, 80, 90]) {
    const result = observe(checkpoint);
    assert.equal(result.dueCheckpointPercentage, checkpoint);
    recordPercentageNudge(state, projectionId, checkpoint);
  }

  const compressionDrop = observe(55);
  assert.equal(compressionDrop.rearmed, true);
  assert.equal(compressionDrop.nextCheckpointPercentage, 70);
  assert.equal(compressionDrop.percentageNudgeDue, false);
  assert.equal(observe(69).percentageNudgeDue, false);
  assert.equal(observe(70).dueCheckpointPercentage, 70);
  recordPercentageNudge(state, projectionId, 70);
  assert.equal(observe(80).dueCheckpointPercentage, 80);

  const noisyState = createEmptyState("/noise.jsonl");
  const noisyId = "c".repeat(64);
  let noisy = ensurePercentageCadence(noisyState, noisyId, 800, 1000, 70, 10);
  recordPercentageNudge(noisyState, noisyId, 80);
  noisy = ensurePercentageCadence(noisyState, noisyId, 795, 1000, 70, 10);
  assert.equal(noisy.rearmed, false);
  assert.equal(noisy.nextCheckpointPercentage, 90);
  noisy = ensurePercentageCadence(noisyState, noisyId, 789, 1000, 70, 10);
  assert.equal(noisy.rearmed, true);
  assert.equal(noisy.nextCheckpointPercentage, 80);

  const overBudgetState = createEmptyState("/over-budget.jsonl");
  const over = ensurePercentageCadence(overBudgetState, "d".repeat(64), 214000, 200000, 70, 10);
  assert.equal(over.currentUsedPercentage, 107);
  assert.equal(over.currentRemainingPercentage, -7);
  assert.equal(over.contextBudgetDeltaTokens, -14000);
});

test("percentage checkpoint jumps deliver the earliest pending threshold first", () => {
  const state = createEmptyState("/jump.jsonl");
  const projectionId = "d".repeat(64);
  const observe = (used) => ensurePercentageCadence(state, projectionId, used, 10_000, 80, 5);

  let result = observe(8_750);
  assert.equal(result.percentageNudgeDue, true);
  assert.equal(result.dueCheckpointPercentage, 80);
  recordPercentageNudge(state, projectionId, result.dueCheckpointPercentage);

  result = observe(8_750);
  assert.equal(result.dueCheckpointPercentage, 85);
  recordPercentageNudge(state, projectionId, result.dueCheckpointPercentage);
  assert.equal(observe(8_750).percentageNudgeDue, false);
  assert.equal(observe(9_000).dueCheckpointPercentage, 90);
});

test("versioned manifest commits immutable chunks and keeps large provenance out of the index", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-state-"));
  try {
    const sessionPath = path.join(directory, "abc123.jsonl");
    const target = sidecarPath(sessionPath);
    assert.equal(storageFolderPath(sessionPath), `${sessionPath}.big-pi`);
    assert.equal(target, path.join(storageFolderPath(sessionPath), "manifest.json"));
    const state = createEmptyState(sessionPath);
    const projection = fixtureProjection(5, { messageChars: 40 });
    const bindings = ensureMessageReferences(state, projection);
    const block = applyCompression(
      state,
      bindings,
      protectedRefs(bindings),
      bindings[1].ref,
      bindings[2].ref,
      "Remember the key implementation decision.",
      1,
    );
    persistState(target, state);
    const loaded = readState(target, sessionPath).state;
    assert.equal(loaded.schemaVersion, 1);
    assert.deepEqual(loaded.blocks[0].sourceLineage, block.sourceLineage);
    const manifest = JSON.parse(readFileSync(target, "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.session.sessionPath, sessionPath);
    assert.deepEqual(manifest.blocks.map(({ blockId, tier }) => ({ blockId, tier })), [
      { blockId: block.id, tier: 1 },
    ]);
    assert.equal(manifest.blocks[0].chunkPath, "blocks/B000001.json");
    assert.equal(JSON.stringify(manifest).includes(block.summary), false);
    assert.equal(Object.hasOwn(manifest.blocks[0], "sourceLineage"), false);
    const chunk = JSON.parse(readFileSync(path.join(storageFolderPath(sessionPath), manifest.blocks[0].chunkPath), "utf8"));
    assert.equal(chunk.blockId, block.id);
    assert.equal(chunk.summary, block.summary);
    assert.deepEqual(chunk.provenance.sourceLineage, block.sourceLineage);
    assert.equal(readFileSync(target, "utf8").endsWith("\n"), true);
    const bytesBefore = readFileSync(path.join(storageFolderPath(sessionPath), manifest.blocks[0].chunkPath));
    persistState(target, loaded);
    assert.deepEqual(
      readFileSync(path.join(storageFolderPath(sessionPath), manifest.blocks[0].chunkPath)),
      bytesBefore,
    );
    assert.ok(storageDiskUsage(sessionPath) > bytesBefore.length);

    manifest.schemaVersion = 99;
    writeFileSync(target, JSON.stringify(manifest));
    assert.throws(() => readState(target, sessionPath), /Unsupported or invalid big-pi manifest/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("previous single-sidecar state is not migrated into the manifest format", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-migrate-"));
  try {
    const sessionPath = path.join(directory, "legacy.jsonl");
    const state = createEmptyState(sessionPath);
    const target = sidecarPath(sessionPath);
    mkdirSync(path.dirname(target), { recursive: true });
    state.schemaVersion = 6;
    writeFileSync(target, JSON.stringify(state));
    assert.throws(() => readState(target, sessionPath), /Unsupported or invalid big-pi manifest/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing chunks disable dependent ancestors while unrelated blocks and raw context remain usable", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-local-recovery-"));
  try {
    const sessionPath = path.join(directory, "session.jsonl");
    const projection = fixtureProjection(10, { messageChars: 180 });
    const state = createEmptyState(sessionPath);
    const bindings = ensureMessageReferences(state, projection);
    const tier1 = createTier1Blocks(state, projection, bindings, 3, 2);
    const tier2 = createHierarchicalBlock(
      state,
      bindings,
      tier1.slice(0, 2).map((block) => block.id),
      "Consolidate the first completed phases and their verified state.",
      { enabled: true, minBlocksPerPromotion: 2 },
      1,
    );
    const manifestPath = sidecarPath(sessionPath);
    persistState(manifestPath, state);
    const manifestBefore = JSON.parse(readFileSync(manifestPath, "utf8"));
    const brokenChunkPath = path.join(storageFolderPath(sessionPath), manifestBefore.blocks[0].chunkPath);
    rmSync(brokenChunkPath);

    const loaded = readState(manifestPath, sessionPath);
    assert.equal(loaded.recovery.length, 1);
    assert.equal(loaded.recovery[0].blockId, tier1[0].id);
    assert.match(loaded.state.blocks.find((block) => block.id === tier1[0].id).storageError, /ENOENT|missing/);
    const restoredBindings = ensureMessageReferences(loaded.state, projection);
    const transformed = transformContext(
      projection.messages,
      restoredBindings,
      loaded.state.blocks,
      protectedRefs(restoredBindings),
    );
    const rendered = transformed.map((message) => message.content?.[0]?.text ?? "").join("\n");
    assert.equal(rendered.includes(tier2.id), false);
    assert.equal(rendered.includes(tier1[0].id), false);
    assert.ok(rendered.includes(tier1[1].id));
    assert.ok(rendered.includes(tier1[2].id));
    assert.ok(rendered.includes("message-1:"));

    persistState(manifestPath, loaded.state);
    const manifestAfter = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(manifestAfter.blocks, manifestBefore.blocks);
    assert.equal(readState(manifestPath, sessionPath).state.blocks.length, manifestBefore.blocks.length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corrupt committed chunk content falls back locally without adopting orphan files", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-corrupt-chunk-"));
  try {
    const sessionPath = path.join(directory, "session.jsonl");
    const projection = fixtureProjection(8, { messageChars: 180 });
    const state = createEmptyState(sessionPath);
    const bindings = ensureMessageReferences(state, projection);
    const block = applyCompression(
      state, bindings, protectedRefs(bindings), bindings[1].ref, bindings[2].ref, "Preserve durable state.", 1,
    );
    const manifestPath = sidecarPath(sessionPath);
    persistState(manifestPath, state);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const chunkPath = path.join(storageFolderPath(sessionPath), manifest.blocks[0].chunkPath);
    writeFileSync(chunkPath, "{ damaged chunk");
    writeFileSync(path.join(storageFolderPath(sessionPath), "blocks", "unreferenced.json"), "{}");

    const loaded = readState(manifestPath, sessionPath);
    assert.equal(loaded.recovery[0].blockId, block.id);
    assert.match(loaded.recovery[0].reason, /checksum/);
    assert.equal(loaded.state.blocks.length, 1);
    assert.equal(loaded.state.blocks[0].storageError !== undefined, true);
    const loadedBindings = ensureMessageReferences(loaded.state, projection);
    const transformed = transformContext(projection.messages, loadedBindings, loaded.state.blocks);
    assert.equal(transformed.some((message) => message.content?.[0]?.text?.includes(block.id)), false);
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).blocks.length, 1);
    assert.ok(storageDiskUsage(sessionPath) > readFileSync(manifestPath).length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("committed chunk IDs are immutable and failed manifest commits leave prior references intact", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-immutable-chunks-"));
  try {
    const sessionPath = path.join(directory, "session.jsonl");
    const projection = fixtureProjection(10, { messageChars: 180 });
    const state = createEmptyState(sessionPath);
    const bindings = ensureMessageReferences(state, projection);
    const first = applyCompression(
      state, bindings, protectedRefs(bindings), bindings[1].ref, bindings[2].ref, "First durable summary.", 1,
    );
    const manifestPath = sidecarPath(sessionPath);
    persistState(manifestPath, state);
    const manifestBefore = readFileSync(manifestPath);
    const chunkPath = path.join(storageFolderPath(sessionPath), state.blocks[0]._storageIndex.chunkPath);
    const chunkBefore = readFileSync(chunkPath);
    first.summary = "Different contents under the same committed block ID.";
    assert.throws(() => persistState(manifestPath, state), /immutable/);
    assert.deepEqual(readFileSync(manifestPath), manifestBefore);
    assert.deepEqual(readFileSync(chunkPath), chunkBefore);
    first.summary = "First durable summary.";

    applyCompression(
      state, bindings, protectedRefs(bindings), bindings[4].ref, bindings[5].ref, "Second durable summary.", 1,
    );
    const savedManifest = `${manifestPath}.previous`;
    renameSync(manifestPath, savedManifest);
    mkdirSync(manifestPath);
    assert.throws(() => persistState(manifestPath, state));
    assert.deepEqual(readFileSync(savedManifest), manifestBefore);
    const priorIndex = JSON.parse(readFileSync(savedManifest, "utf8")).blocks;
    assert.deepEqual(priorIndex.map((entry) => entry.blockId), [first.id]);
    const orphanPath = path.join(storageFolderPath(sessionPath), "blocks", "B000002.json");
    assert.equal(existsSync(orphanPath), true);

    rmSync(manifestPath, { recursive: true, force: true });
    renameSync(savedManifest, manifestPath);
    persistState(manifestPath, state);
    const committed = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(committed.blocks.length, 2);
    assert.notEqual(committed.blocks[1].chunkPath, "blocks/B000002.json");
    assert.equal(readState(manifestPath, sessionPath).state.blocks.length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manifest chunk paths cannot escape storage and symlink chunks are not followed", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-safe-storage-"));
  try {
    const sessionPath = path.join(directory, "session.jsonl");
    const projection = fixtureProjection(8, { messageChars: 180 });
    const state = createEmptyState(sessionPath);
    const bindings = ensureMessageReferences(state, projection);
    applyCompression(state, bindings, protectedRefs(bindings), bindings[1].ref, bindings[2].ref, "Safe summary.", 1);
    const manifestPath = sidecarPath(sessionPath);
    persistState(manifestPath, state);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.blocks[0].chunkPath = "../outside.json";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => readState(manifestPath, sessionPath), /invalid or duplicate committed chunk index entry/);

    persistState(manifestPath, state);
    const validManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const linkedChunk = path.join(storageFolderPath(sessionPath), validManifest.blocks[0].chunkPath);
    const outside = path.join(directory, "outside.json");
    writeFileSync(outside, "external secret".repeat(100));
    rmSync(linkedChunk);
    try {
      symlinkSync(outside, linkedChunk);
    } catch (error) {
      t.skip(`file symlinks unavailable: ${error.message}`);
      return;
    }
    const loaded = readState(manifestPath, sessionPath);
    assert.equal(loaded.recovery[0].blockId, validManifest.blocks[0].blockId);
    assert.match(loaded.recovery[0].reason, /symlink/);
    assert.equal(storageDiskUsage(sessionPath), readFileSync(manifestPath).length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("status, block inspection, and logical dumps expose manifest and committed-chunk diagnostics", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-storage-diagnostics-"));
  const projection = fixtureProjection(8, { messageChars: 180 });
  const harness = extensionHarness(directory, () => projection, { minCompressRangeChars: 1 });
  try {
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const sources = await harness.tools.get("big_pi_compression_sources")
      .execute("raw", { sourceType: "raw" }, undefined, undefined, harness.ctx);
    const range = JSON.parse(sources.content[0].text).eligibleRanges[0];
    const applied = await harness.tools.get("big_pi_compress").execute("diagnostic", {
      startRef: range.startRef,
      endRef: range.endRef,
      summary: "Retain the completed result for diagnostic output.",
    }, undefined, undefined, harness.ctx);
    assert.equal(applied.isError, undefined);
    const blockId = /Compression applied as (B\d+)/.exec(applied.content[0].text)[1];

    await harness.commands.get("big-pi").handler("status", harness.ctx);
    assert.match(harness.notices.at(-1), /Manifest: .*\.jsonl\.big-pi\/manifest\.json/);
    assert.match(harness.notices.at(-1), /Committed chunks: 1/);
    assert.match(harness.notices.at(-1), /disk usage: \d+ bytes/);
    await harness.commands.get("big-pi").handler("blocks", harness.ctx);
    assert.match(harness.notices.at(-1), new RegExp(`${blockId} T1 chunk=blocks/${blockId}\\.json`));
    await harness.commands.get("big-pi").handler(`inspect ${blockId}`, harness.ctx);
    assert.match(harness.notices.at(-1), /"chunkIntegrity": "valid"/);
    assert.match(harness.notices.at(-1), /"chunkPath": "blocks\//);

    const loaded = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    const bindings = ensureMessageReferences(loaded, projection);
    const dump = renderContextDump(projection.messages, bindings, loaded.blocks, new Set(), {
      manifestPath: sidecarPath(harness.sessionPath),
      committedChunkCount: loaded.blocks.length,
      diskUsageBytes: storageDiskUsage(harness.sessionPath),
    });
    assert.match(dump, /Committed chunks: 1/);
    assert.match(dump, /Storage disk usage: \d+ bytes/);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("logging failure is best-effort and cannot throw into Pi", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-log-"));
  try {
    const blocker = path.join(directory, "not-a-directory");
    writeFileSync(blocker, "file");
    const log = createLogger({ logPath: path.join(blocker, "big-pi.log") });
    assert.doesNotThrow(() => log("error", "this must not break Pi"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("BIG_PI_LOG_PATH redirects the development log to the selected run folder", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-log-redirect-"));
  const target = path.join(directory, "isolated", "big-pi.log");
  const previous = process.env.BIG_PI_LOG_PATH;
  try {
    process.env.BIG_PI_LOG_PATH = target;
    createLogger()("info", "isolated benchmark log");
    assert.match(readFileSync(target, "utf8"), /isolated benchmark log/);
  } finally {
    if (previous === undefined) delete process.env.BIG_PI_LOG_PATH;
    else process.env.BIG_PI_LOG_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stable refs follow Pi entry identity through state-only projection entries", () => {
  const state = createEmptyState("/session.jsonl");
  const projection = fixtureProjection(5, { stateOnly: true });
  const first = ensureMessageReferences(state, projection);
  const refs = first.map((item) => item.ref);
  assert.equal(first.length, projection.messages.length);
  assert.deepEqual(ensureMessageReferences(state, projection).map((item) => item.ref), refs);
  assert.equal(refs.length, 5);
  const expanded = ensureMessageReferences(state, fixtureProjection(7, { prefix: "entry", stateOnly: true }));
  assert.deepEqual(expanded.map((item) => item.ref), [...refs, "M000006", "M000007"]);
  assert.equal(bindContextMessages(projection.messages, first).length, 5);
});

test("protected zone includes the initial/latest user and recent message/token tails", () => {
  const state = createEmptyState("/session.jsonl");
  const bindings = ensureMessageReferences(state, fixtureProjection(8));
  const protectedRegion = computeProtectedRefs(bindings, {
    protectedRecentMessages: 2,
    protectedRecentTokens: 0,
  });
  assert.deepEqual([...protectedRegion.refs].sort(), ["M000001", "M000007", "M000008"]);
  const zeroTail = computeProtectedRefs(bindings, {
    protectedRecentMessages: 0,
    protectedRecentTokens: 0,
  });
  assert.deepEqual([...zeroTail.refs], ["M000001", "M000008"]);
});

test("range validation rejects protected, covered, short, reversed, and non-contiguous ranges", () => {
  const state = createEmptyState("/session.jsonl");
  const projection = fixtureProjection(8, { stateOnly: true, messageChars: 100 });
  const bindings = ensureMessageReferences(state, projection);
  const protectedRegion = protectedRefs(bindings, { protectedRecentMessages: 2 });
  assert.throws(() => validateSelectedRange(bindings, protectedRegion, [], "M000002", "M000007", 1), /protected/);
  const selected = validateSelectedRange(bindings, protectedRegion, [], "M000002", "M000005", 1);
  applyCompression(state, bindings, protectedRegion, selected[0].ref, selected.at(-1).ref, "Keep the decision.", 1);
  assert.throws(
    () => validateSelectedRange(bindings, protectedRegion, state.blocks, "M000003", "M000005", 1),
    /already covered/,
  );
  assert.throws(
    () => validateSelectedRange(bindings, protectedRegion, [], "M000004", "M000002", 1),
    /reversed/,
  );
  const discontinuous = bindings.map((binding) => ({ ...binding }));
  discontinuous[2].contextIndex += 1;
  assert.throws(
    () => validateSelectedRange(discontinuous, new Set(), [], "M000002", "M000004", 1),
    /non-contiguous/,
  );
  assert.throws(
    () => validateSelectedRange(bindings, new Set(), [], "M000002", "M000003", 5000),
    /below the 5000-character minimum/,
  );
});

test("raw compression preserves complete Pi tool-call/result exchanges with multiple calls", () => {
  const projection = toolExchangeProjection();
  const state = createEmptyState("/tool-exchange.jsonl");
  const bindings = ensureMessageReferences(state, projection);
  const protectedSet = computeProtectedRefs(bindings, {
    protectedRecentMessages: 1,
    protectedRecentTokens: 0,
  }).refs;
  const assistant = bindings[1];
  const firstResult = bindings[2];
  const secondResult = bindings[3];
  assert.throws(
    () => applyCompression(
      state, bindings, protectedSet, assistant.ref, assistant.ref, "Tool activity summary.", 1, projection.messages,
    ),
    /splits tool call call-alpha/,
  );
  assert.throws(
    () => applyCompression(
      state, bindings, protectedSet, firstResult.ref, secondResult.ref, "Tool results summary.", 1, projection.messages,
    ),
    /splits tool call call-alpha/,
  );
  assert.throws(
    () => applyCompression(
      state, bindings, protectedSet, assistant.ref, firstResult.ref, "Partial tool summary.", 1, projection.messages,
    ),
    /splits tool call call-beta/,
  );

  const block = applyCompression(
    state,
    bindings,
    protectedSet,
    assistant.ref,
    secondResult.ref,
    "The two file inspections completed and both returned successfully.",
    1,
    projection.messages,
  );
  assert.equal(block.sourceMessageCount, 3);
  const transformed = transformContext(projection.messages, bindings, state.blocks, protectedSet);
  const callsAfter = transformed.flatMap((message) =>
    message.role === "assistant" ? message.content.filter((part) => part.type === "toolCall") : []
  );
  const resultsAfter = transformed.filter((message) => message.role === "toolResult");
  assert.equal(callsAfter.some((call) => call.id === "call-alpha" || call.id === "call-beta"), false);
  assert.equal(resultsAfter.some((result) => result.toolCallId === "call-alpha" || result.toolCallId === "call-beta"), false);
  assert.equal(transformed.some((message) => message.content?.[0]?.text?.includes(block.id)), true);

  const legacyState = createEmptyState("/legacy-partial-tool-block.jsonl");
  const legacyBindings = ensureMessageReferences(legacyState, projection);
  const unsafeBlock = createBlock(legacyState, [legacyBindings[1]], "A partial tool-call summary.");
  const unsafeResultBlock = createBlock(legacyState, [legacyBindings[2]], "A partial tool-result summary.");
  const legacyApplicability = getBlockApplicability(projection.messages, legacyBindings, legacyState.blocks);
  assert.equal(legacyApplicability.applicableBlockIds.has(unsafeBlock.id), false);
  assert.equal(legacyApplicability.applicableBlockIds.has(unsafeResultBlock.id), false);
  assert.match(legacyApplicability.skippedBlockReasons.get(unsafeBlock.id), /splits tool call call-alpha/);
  const legacyBlocksBeforePromotion = structuredClone(legacyState.blocks);
  assert.throws(
    () => createHierarchicalBlock(
      legacyState,
      legacyBindings,
      [unsafeBlock.id, unsafeResultBlock.id],
      "Unsafe split exchange.",
      { enabled: true, minBlocksPerPromotion: 2 },
      1,
      new Set(),
      projection.messages,
    ),
    /applicable and active in the current projection/,
  );
  assert.deepEqual(legacyState.blocks, legacyBlocksBeforePromotion);
  assert.deepEqual(transformContext(projection.messages, legacyBindings, legacyState.blocks), projection.messages);
});

test("existing Tier-1 and higher-tier blocks respect changing protection tails and reactivate when safe", () => {
  const projection = fixtureProjection(16, { messageChars: 1000 });
  const state = createEmptyState("/protection-navigation.jsonl");
  const bindings = ensureMessageReferences(state, projection);
  const unprotected = computeProtectedRefs(bindings, {
    protectedRecentMessages: 1,
    protectedRecentTokens: 0,
  }).refs;
  const tier1 = createTier1Blocks(state, projection, bindings, 4, 2);
  const tier2 = createHierarchicalBlock(
    state,
    bindings,
    tier1.slice(0, 2).map((block) => block.id),
    "Consolidate the first two completed phases.",
    { enabled: true, minBlocksPerPromotion: 2 },
    1,
    unprotected,
    projection.messages,
  );

  const protectedTail = computeProtectedRefs(bindings, {
    protectedRecentMessages: 15,
    protectedRecentTokens: 0,
  }).refs;
  const protectedApplicability = getBlockApplicability(
    projection.messages,
    bindings,
    state.blocks,
    protectedTail,
  );
  assert.equal(protectedApplicability.applicableBlockIds.size, 0);
  assert.match(protectedApplicability.skippedBlockReasons.get(tier2.id), /descendant source mismatch/);
  const protectedTransform = transformContext(projection.messages, bindings, state.blocks, protectedTail);
  assert.deepEqual(protectedTransform, projection.messages);
  assert.equal(applicableCoveredRefs(bindings, state.blocks, protectedTail, projection.messages).size, 0);
  const protectedMetricsState = structuredClone(state);
  updateMetrics(
    protectedMetricsState,
    bindings,
    protectedTail,
    projection.messages,
    protectedTransform,
  );
  assert.equal(protectedMetricsState.metrics.activeBlockCount, 0);
  assert.equal(protectedMetricsState.metrics.coveredSourceMessages, 0);
  assert.throws(
    () => createHierarchicalBlock(
      state,
      bindings,
      tier1.slice(2, 4).map((block) => block.id),
      "Cannot promote protected history.",
      { enabled: true, minBlocksPerPromotion: 2 },
      1,
      protectedTail,
      projection.messages,
    ),
    /applicable and active in the current projection/,
  );

  const restored = getBlockApplicability(projection.messages, bindings, state.blocks, unprotected);
  assert.equal(restored.applicableBlockIds.has(tier2.id), true);
  const restoredTransform = transformContext(projection.messages, bindings, state.blocks, unprotected);
  assert.equal(restoredTransform.filter((message) => message.content?.[0]?.text?.includes(tier2.id)).length, 1);

  const tier1State = createEmptyState("/protection-tier1.jsonl");
  const tier1Bindings = ensureMessageReferences(tier1State, projection);
  const soloTier1 = applyCompression(
    tier1State,
    tier1Bindings,
    unprotected,
    tier1Bindings[2].ref,
    tier1Bindings[3].ref,
    "A completed phase summary.",
    1,
    projection.messages,
  );
  const protectedTier1 = getBlockApplicability(
    projection.messages,
    tier1Bindings,
    tier1State.blocks,
    protectedTail,
  );
  assert.equal(protectedTier1.applicableBlockIds.has(soloTier1.id), false);
  assert.deepEqual(
    transformContext(projection.messages, tier1Bindings, tier1State.blocks, protectedTail),
    projection.messages,
  );
  assert.equal(
    getBlockApplicability(projection.messages, tier1Bindings, tier1State.blocks, unprotected)
      .applicableBlockIds.has(soloTier1.id),
    true,
  );
});

test("a protected tool result makes its otherwise eligible call undiscoverable and uncompressible", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-protected-tool-result-"));
  const projection = toolExchangeProjection({ finalUser: false, finalResultLast: true });
  const harness = extensionHarness(directory, () => projection, {
    protectedRecentMessages: 1,
    minCompressRangeChars: 1,
  });
  try {
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const listed = await harness.tools.get("big_pi_compression_sources")
      .execute("raw", { sourceType: "raw" }, undefined, undefined, harness.ctx);
    const ranges = JSON.parse(listed.content[0].text).eligibleRanges;
    const allRefs = ranges.flatMap((range) => range.sources.map((source) => source.ref));
    const bindings = ensureMessageReferences(createEmptyState(harness.sessionPath), projection);
    assert.equal(allRefs.includes(bindings[1].ref), false);
    assert.equal(allRefs.includes(bindings[3].ref), false);
    const rejected = await harness.tools.get("big_pi_compress").execute("protected-tool", {
      startRef: bindings[1].ref,
      endRef: bindings[3].ref,
      summary: "Tool calls and results must remain paired.",
    }, undefined, undefined, harness.ctx);
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /protected|splits tool call/i);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("discovery propagates protection across calls sharing one assistant message", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-shared-tool-calls-"));
  const projection = toolExchangeProjection({
    finalUser: false,
    finalResultLast: true,
    lastResultId: "call-alpha",
  });
  const harness = extensionHarness(directory, () => projection, {
    protectedRecentMessages: 1,
    minCompressRangeChars: 1,
  });
  try {
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const bindings = ensureMessageReferences(createEmptyState(harness.sessionPath), projection);
    const listed = await harness.tools.get("big_pi_compression_sources")
      .execute("shared", { sourceType: "raw" }, undefined, undefined, harness.ctx);
    const refs = JSON.parse(listed.content[0].text).eligibleRanges
      .flatMap((range) => range.sources.map((source) => source.ref));
    assert.equal(refs.includes(bindings[1].ref), false);
    assert.equal(refs.includes(bindings[2].ref), false);
    assert.equal(refs.includes(bindings[3].ref), false);
    const rejected = await harness.tools.get("big_pi_compress").execute("shared-partial", {
      startRef: bindings[1].ref,
      endRef: bindings[2].ref,
      summary: "One unprotected result is not independent from its shared call message.",
    }, undefined, undefined, harness.ctx);
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /splits tool call call-alpha/);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("minimum qualification accepts exact/above source characters and requires useful reduction", () => {
  const state = createEmptyState("/session.jsonl");
  const projection = fixtureProjection(5, { messageChars: 30 });
  const bindings = ensureMessageReferences(state, projection);
  const selected = bindings.slice(1, 3);
  const sourceChars = selected.reduce((total, binding) => total + messageText(binding.message).length, 0);
  assert.equal(
    applyCompression(state, bindings, new Set(), selected[0].ref, selected.at(-1).ref, "Keep a concise conclusion.", sourceChars).sourceCharCount,
    sourceChars,
  );

  const aboveState = createEmptyState("/session.jsonl");
  const aboveBindings = ensureMessageReferences(aboveState, projection);
  const above = aboveBindings.slice(1, 3);
  assert.doesNotThrow(() => applyCompression(
    aboveState,
    aboveBindings,
    new Set(),
    above[0].ref,
    above.at(-1).ref,
    "Keep a concise conclusion.",
    sourceChars - 1,
  ));

  const shortState = createEmptyState("/session.jsonl");
  const shortBindings = ensureMessageReferences(shortState, projection);
  const short = shortBindings.slice(1, 3);
  assert.throws(
    () => applyCompression(shortState, shortBindings, new Set(), short[0].ref, short.at(-1).ref, "Keep it.", sourceChars + 1),
    /below the/,
  );

  const largeState = createEmptyState("/session.jsonl");
  const largeBindings = ensureMessageReferences(largeState, projection);
  const large = largeBindings.slice(1, 3);
  assert.throws(
    () => applyCompression(
      largeState,
      largeBindings,
      new Set(),
      large[0].ref,
      large.at(-1).ref,
      "z".repeat(1000),
      1,
    ),
    /smaller than its source/,
  );
});

test("Tier-1 rejects a bare-summary saving when the fully rendered wrapper grows context", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-rendered-benefit-"));
  const projection = fixtureProjection(3, { messageChars: 1 });
  const directState = createEmptyState(path.join(directory, "direct.jsonl"));
  const directBindings = ensureMessageReferences(directState, projection);
  const directProtected = computeProtectedRefs(directBindings, {
    protectedRecentMessages: 1,
    protectedRecentTokens: 0,
  }).refs;
  const directSnapshot = structuredClone(directState);
  assert.ok(estimateTokens("x") < estimateTokens(projection.messages[1]));
  assert.throws(
    () => applyCompression(
      directState,
      directBindings,
      directProtected,
      directBindings[1].ref,
      directBindings[1].ref,
      "x",
      1,
      projection.messages,
    ),
    /header and wrapper/,
  );
  assert.deepEqual(directState, directSnapshot);

  const harness = extensionHarness(directory, () => projection, {
    minCompressRangeChars: 1,
    protectedRecentMessages: 1,
  });
  try {
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const sidecar = sidecarPath(harness.sessionPath);
    const listed = await harness.tools.get("big_pi_compression_sources")
      .execute("raw", { sourceType: "raw" }, undefined, undefined, harness.ctx);
    const range = JSON.parse(listed.content[0].text).eligibleRanges[0];
    assert.equal(range.sources.length, 1);
    assert.ok(estimateTokens("x") < estimateTokens(projection.messages[1]));
    const beforeBytes = readFileSync(sidecar, "utf8");
    const beforeState = readState(sidecar, harness.sessionPath).state;
    const rejected = await harness.tools.get("big_pi_compress").execute("wrapper-too-large", {
      startRef: range.startRef,
      endRef: range.endRef,
      summary: "x",
    }, undefined, undefined, harness.ctx);
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /header and wrapper/);
    assert.equal(readFileSync(sidecar, "utf8"), beforeBytes);
    assert.deepEqual(readState(sidecar, harness.sessionPath).state, beforeState);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("context transformation substitutes blocks once and preserves uncovered order", () => {
  const state = createEmptyState("/session.jsonl");
  const projection = fixtureProjection(8, { stateOnly: true, messageChars: 120 });
  const bindings = ensureMessageReferences(state, projection);
  const block = applyCompression(
    state,
    bindings,
    protectedRefs(bindings),
    bindings[1].ref,
    bindings[2].ref,
    "Key decision and test state.",
    100,
  );
  const output = transformContext(projection.messages, bindings, state.blocks);
  assert.equal(output.filter((message) => message.content?.[0]?.text?.includes(block.id)).length, 1);
  assert.equal(output.length, projection.messages.length - 1);
  assert.deepEqual(
    output.filter((message) => !message.content?.[0]?.text?.includes("big-pi compressed context"))
      .map((message) => message.content[0].text),
    projection.messages.filter((message, index) => index !== 1 && index !== 2).map((message) => message.content[0].text),
  );
  const dump = renderContextDump(projection.messages, bindings, state.blocks);
  assert.equal(dump.match(new RegExp(`BIG-PI BLOCK ${block.id}`, "g")).length, 1);
  assert.equal(dump.includes(`RAW ${bindings[1].ref}`), false);
  assert.match(dump, /RAW M000008 USER/);

  const reordered = [...projection.messages];
  [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
  assert.throws(() => transformContext(reordered, bindings, state.blocks), ProjectionError);
  assert.throws(() => transformContext([...projection.messages, projection.messages[1]], bindings, state.blocks), ProjectionError);
});

test("Tier-2 promotion preserves transitive lineage and replaces Tier-1 representations exactly once", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-tier2-"));
  const sessionPath = path.join(directory, "session.jsonl");
  const state = createEmptyState(sessionPath);
  const projection = fixtureProjection(14, { messageChars: 900 });
  const bindings = ensureMessageReferences(state, projection);
  const tier1 = createTier1Blocks(state, projection, bindings, 4, 3);
  assert.ok(tier1.every((block) => block.sourceTokensEstimate === block.originalSourceTokensEstimate));
  const before = transformContext(projection.messages, bindings, state.blocks);
  const summary = "Durable requirements, decisions, unresolved concerns, and successful tests.";
  const tier2 = createHierarchicalBlock(
    state,
    bindings,
    tier1.slice(0, 3).map((block) => block.id),
    summary,
    { enabled: true, minBlocksPerPromotion: 3 },
    1,
  );

  try {
    assert.equal(tier2.tier, 2);
    assert.deepEqual(tier2.sourceBlockIds, tier1.slice(0, 3).map((block) => block.id));
    assert.deepEqual(tier2.effectiveOriginalMessageRefs, tier1.slice(0, 3).flatMap((block) => block.sourceMessageRefs));
    assert.deepEqual(tier2.sourceMessageRefs, []);
    assert.equal(tier2.sourceTokensEstimate, tier1.slice(0, 3).reduce((total, block) => total + block.summaryTokensEstimate, 0));
    assert.equal(tier2.originalSourceTokensEstimate, tier1.slice(0, 3).reduce((total, block) => total + block.originalSourceTokensEstimate, 0));
    assert.notEqual(tier2.sourceTokensEstimate, tier2.originalSourceTokensEstimate);
    assert.equal(state.blocks.length, 5);
    assert.ok(tier1.every((block) => state.blocks.includes(block)));
    assert.ok(tier1.slice(0, 3).every((block) => block.supersededByBlockId === tier2.id));
    assert.equal(tier1[3].supersededByBlockId, null);
    assert.ok(before.some((message) => message.content?.[0]?.text?.includes(tier1[0].id)));

    const transformed = transformContext(projection.messages, bindings, state.blocks);
    assert.equal(transformed.filter((message) => message.content?.[0]?.text?.includes(tier2.id)).length, 1);
    assert.ok(tier1.slice(0, 3).every((block) => !transformed.some((message) => message.content?.[0]?.text?.includes(block.id))));
    assert.ok(transformed.some((message) => message.content?.[0]?.text?.includes(tier1[3].id)));
    const applicable = getBlockApplicability(projection.messages, bindings, state.blocks).applicableBlockIds;
    assert.deepEqual([...applicable].sort(), [tier2.id, tier1[3].id].sort());
    updateMetrics(state, bindings, new Set(), projection.messages, transformed);
    assert.equal(
      state.metrics.sourceTokensRepresentedByApplicableBlocks,
      tier2.originalSourceTokensEstimate + tier1[3].originalSourceTokensEstimate,
    );
    assert.equal(
      state.metrics.applicableBlockDirectSourceTokensEstimate,
      tier2.sourceTokensEstimate + tier1[3].sourceTokensEstimate,
    );
    assert.equal(state.metrics.projectedOriginalRawContextTokensEstimate, estimateTokens(projection.messages));
    assert.equal(state.metrics.blockSummaryTokensEstimate, tier2.summaryTokensEstimate + tier1[3].summaryTokensEstimate);

    const target = sidecarPath(sessionPath);
    persistState(target, state);
    const reloaded = readState(target, sessionPath).state;
    assert.equal(reloaded.schemaVersion, 1);
    assert.deepEqual(reloaded.blocks.find((block) => block.id === tier2.id).effectiveOriginalMessageRefs, tier2.effectiveOriginalMessageRefs);
    assert.deepEqual(transformContext(projection.messages, bindings, reloaded.blocks), transformed);
    const cyclic = JSON.parse(readFileSync(target, "utf8"));
    cyclic.blocks.at(-1).sourceBlockIds[0] = cyclic.blocks.at(-1).blockId;
    cyclic.blocks.at(-1).supersedesBlockIds[0] = cyclic.blocks.at(-1).blockId;
    writeFileSync(target, JSON.stringify(cyclic));
    assert.throws(() => readState(target, sessionPath), StateIntegrityError);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("higher-tier promotion rejects invalid, mixed, non-contiguous, and non-beneficial selections", () => {
  const projection = fixtureProjection(22, { messageChars: 700 });
  const state = createEmptyState("/tier-reject.jsonl");
  const bindings = ensureMessageReferences(state, projection);
  const tier1 = createTier1Blocks(state, projection, bindings, 6, 3);
  const config = { enabled: true, minBlocksPerPromotion: 2 };
  assert.throws(() => createHierarchicalBlock(state, bindings, [tier1[0].id], "Too few.", config, 1), /at least 2/);
  assert.throws(() => createHierarchicalBlock(state, bindings, ["B999999", tier1[0].id], "Unknown.", config, 1), /Unknown source block/);
  assert.throws(() => createHierarchicalBlock(state, bindings, [tier1[2].id, tier1[1].id], "Reversed.", config, 1), /reversed or non-contiguous/);
  assert.throws(() => createHierarchicalBlock(state, bindings, [tier1[0].id, tier1[2].id], "Skipped block.", config, 1), /reversed or non-contiguous/);
  assert.throws(() => createHierarchicalBlock(state, bindings, tier1.slice(0, 3).map((block) => block.id), "z".repeat(1000), config, 1), /smaller than its source/);
  assert.throws(() => createHierarchicalBlock(state, bindings, tier1.slice(0, 3).map((block) => block.id), "Tiny.", { ...config, enabled: false }, 1), /disabled/);
  tier1[3].status = "stale";
  tier1[3].staleReason = "fixture lifecycle";
  assert.throws(() => createHierarchicalBlock(state, bindings, [tier1[3].id, tier1[4].id], "Inactive.", config, 1), /active lifecycle/);
  tier1[3].status = "active";
  delete tier1[3].staleReason;
  const changed = structuredClone(projection);
  const changedEntry = changed.entries.find((entry) => entry.sourceEntry.id === bindings[10].entryId);
  changedEntry.messages[0] = textMessage("assistant", `edited ${"x".repeat(700)}`);
  changed.messages = changed.entries.flatMap((entry) => entry.messages);
  const changedBindings = ensureMessageReferences(state, changed);
  assert.throws(
    () => createHierarchicalBlock(state, changedBindings, [tier1[3].id, tier1[4].id], "Inapplicable.", config, 1),
    /applicable and active/,
  );
  const tier2 = createHierarchicalBlock(
    state, bindings, tier1.slice(0, 3).map((block) => block.id),
    "A compact durable phase record with preserved architecture and tests.", config, 1,
  );
  assert.throws(() => createHierarchicalBlock(state, bindings, [tier1[0].id, tier1[1].id], "Again.", config, 1), /already superseded/);
  assert.throws(
    () => createHierarchicalBlock(state, bindings, [tier2.id, tier1[3].id], "Mixed.", config, 1),
    /cannot mix source tiers/,
  );
  assert.throws(
    () => createHierarchicalBlock(state, bindings, [tier2.id, tier1[0].id], "Mixed.", config, 1),
    /cannot mix source tiers/,
  );
});

test("Tier-3 promotion persists full lineage, exact-one rendering, restart state, and rejects Tier-4", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-tier3-"));
  const sessionPath = path.join(directory, "session.jsonl");
  const state = createEmptyState(sessionPath);
  const projection = fixtureProjection(40, { messageChars: 900 });
  const bindings = ensureMessageReferences(state, projection);
  const tier1 = createTier1Blocks(state, projection, bindings, 12, 3);
  const config = { enabled: true, minBlocksPerPromotion: 2 };
  const tier2 = [];
  for (let index = 0; index < 4; index++) {
    tier2.push(createHierarchicalBlock(state, bindings, tier1.slice(index * 3, index * 3 + 3).map((block) => block.id),
      `Consolidated completed implementation phase ${index + 1} with durable decisions, state, and verified behavior.`, config, 1));
  }
  const tier3 = [
    createHierarchicalBlock(state, bindings, tier2.slice(0, 2).map((block) => block.id),
      "Durable first multi-phase state, open risks, and verification.", config, 1),
    createHierarchicalBlock(state, bindings, tier2.slice(2, 4).map((block) => block.id),
      "Durable second multi-phase state, open risks, and verification.", config, 1),
  ];
  const transformed = transformContext(projection.messages, bindings, state.blocks);
  assert.ok(tier3.every((block) => block.tier === 3));
  assert.ok(tier3.every((block) =>
    block.sourceTokensEstimate === tier2.slice(tier3.indexOf(block) * 2, tier3.indexOf(block) * 2 + 2)
      .reduce((total, child) => total + child.summaryTokensEstimate, 0)
  ));
  assert.ok(tier3.every((block) =>
    block.originalSourceTokensEstimate === tier2.slice(tier3.indexOf(block) * 2, tier3.indexOf(block) * 2 + 2)
      .reduce((total, child) => total + child.originalSourceTokensEstimate, 0)
  ));
  assert.deepEqual(tier3[0].effectiveOriginalMessageRefs, tier1.slice(0, 6).flatMap((block) => block.sourceMessageRefs));
  assert.deepEqual(tier3[1].effectiveOriginalMessageRefs, tier1.slice(6).flatMap((block) => block.sourceMessageRefs));
  assert.ok(tier3.every((block) => transformed.filter((message) => message.content?.[0]?.text?.includes(block.id)).length === 1));
  assert.ok([...tier1, ...tier2].every((block) => !transformed.some((message) => message.content?.[0]?.text?.includes(block.id))));
  assert.ok(tier1.every((block) => state.blocks.includes(block)));
  assert.throws(() => createHierarchicalBlock(state, bindings, tier3.map((block) => block.id), "Tier 4.", config, 1), /Tier-3 is the highest/);
  updateMetrics(state, bindings, new Set(), projection.messages, transformed);
  assert.equal(
    state.metrics.sourceTokensRepresentedByApplicableBlocks,
    tier3.reduce((total, block) => total + block.originalSourceTokensEstimate, 0),
  );
  assert.equal(
    state.metrics.applicableBlockDirectSourceTokensEstimate,
    tier3.reduce((total, block) => total + block.sourceTokensEstimate, 0),
  );
  assert.equal(state.metrics.blockSummaryTokensEstimate, tier3.reduce((total, block) => total + block.summaryTokensEstimate, 0));

  try {
    const beforeRefs = tier3.map((block) => block.effectiveOriginalMessageRefs);
    const target = sidecarPath(sessionPath);
    persistState(target, state);
    const reloaded = readState(target, sessionPath).state;
    assert.equal(reloaded.schemaVersion, 1);
    assert.deepEqual(reloaded.blocks.map((block) => block.id), state.blocks.map((block) => block.id));
    assert.deepEqual(
      reloaded.blocks.map(({ id, tier, sourceBlockIds, supersedesBlockIds, supersededByBlockId }) =>
        ({ id, tier, sourceBlockIds, supersedesBlockIds, supersededByBlockId })),
      state.blocks.map(({ id, tier, sourceBlockIds, supersedesBlockIds, supersededByBlockId }) =>
        ({ id, tier, sourceBlockIds, supersedesBlockIds, supersededByBlockId })),
    );
    assert.deepEqual(reloaded.blocks.slice(-2).map((block) => block.effectiveOriginalMessageRefs), beforeRefs);
    assert.deepEqual(
      reloaded.blocks.map((block) => block.originalSourceTokensEstimate),
      state.blocks.map((block) => block.originalSourceTokensEstimate),
    );
    assert.deepEqual(transformContext(projection.messages, bindings, reloaded.blocks), transformed);
    persistState(target, reloaded);
    assert.deepEqual(
      readState(target, sessionPath).state.blocks.map((block) => block.originalSourceTokensEstimate),
      state.blocks.map((block) => block.originalSourceTokensEstimate),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hierarchy applicability cascades locally through changed source and restores on branch return", () => {
  const state = createEmptyState("/hierarchy-branch.jsonl");
  const projection = fixtureProjection(22, { prefix: "branch-a", messageChars: 900 });
  const bindings = ensureMessageReferences(state, projection);
  const tier1 = createTier1Blocks(state, projection, bindings, 6, 3);
  const config = { enabled: true, minBlocksPerPromotion: 2 };
  const tier2 = [
    createHierarchicalBlock(state, bindings, tier1.slice(0, 3).map((block) => block.id),
      "First consolidated phase summary retains durable decisions and status.", config, 1),
    createHierarchicalBlock(state, bindings, tier1.slice(3, 6).map((block) => block.id),
      "Second consolidated phase summary retains requirements and verification.", config, 1),
  ];
  const tier3 = createHierarchicalBlock(state, bindings, tier2.map((block) => block.id),
    "Durable multi-phase state and open work.", config, 1);
  const expected = transformContext(projection.messages, bindings, state.blocks);
  assert.ok(expected.some((message) => message.content?.[0]?.text?.includes(tier3.id)));
  updateMetrics(state, bindings, new Set(), projection.messages, expected);
  assert.equal(state.metrics.sourceTokensRepresentedByApplicableBlocks, tier3.originalSourceTokensEstimate);

  const changed = structuredClone(projection);
  const changedEntry = changed.entries.find((entry) => entry.sourceEntry.id === bindings[2].entryId);
  const originalMessage = changedEntry.messages[0];
  changedEntry.messages[0] = textMessage("toolResult", `changed source ${"c".repeat(900)}`);
  changed.messages = changed.entries.flatMap((entry) => entry.messages);
  const changedBindings = ensureMessageReferences(state, changed);
  const onChangedProjection = transformContext(changed.messages, changedBindings, state.blocks);
  updateMetrics(state, changedBindings, new Set(), changed.messages, onChangedProjection);
  assert.equal(onChangedProjection.some((message) => message.content?.[0]?.text?.includes(tier3.id)), false);
  assert.equal(onChangedProjection.some((message) => message.content?.[0]?.text?.includes(tier2[0].id)), false);
  assert.equal(onChangedProjection.some((message) => message.content?.[0]?.text?.includes(tier1[0].id)), false);
  assert.ok(onChangedProjection.some((message) => message.content?.[0]?.text?.includes("changed source")));
  const applicability = getBlockApplicability(changed.messages, changedBindings, state.blocks);
  assert.equal(applicability.skippedBlockReasons.get(tier2[0].id), "descendant source mismatch");
  assert.equal(applicability.skippedBlockReasons.get(tier3.id), "descendant source mismatch");
  assert.equal(
    state.metrics.sourceTokensRepresentedByApplicableBlocks,
    tier1[1].originalSourceTokensEstimate + tier1[2].originalSourceTokensEstimate + tier2[1].originalSourceTokensEstimate,
  );
  assert.equal(
    state.metrics.sourceTokensRepresentedByApplicableBlocks,
    [...applicability.applicableBlockIds]
      .map((id) => state.blocks.find((block) => block.id === id).originalSourceTokensEstimate)
      .reduce((total, tokens) => total + tokens, 0),
  );

  changedEntry.messages[0] = originalMessage;
  changed.messages = changed.entries.flatMap((entry) => entry.messages);
  const returnedBindings = ensureMessageReferences(state, changed);
  const returned = transformContext(changed.messages, returnedBindings, state.blocks);
  assert.deepEqual(returned, expected);
  updateMetrics(state, returnedBindings, new Set(), changed.messages, returned);
  assert.equal(state.metrics.sourceTokensRepresentedByApplicableBlocks, tier3.originalSourceTokensEstimate);
});

test("context-edit fingerprint mismatch is projection-local and reactivates after sidecar reload", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-context-edit-"));
  const sessionPath = path.join(directory, "session.jsonl");
  const state = createEmptyState(sessionPath);
  const original = fixtureProjection(6, { messageChars: 150 });
  const originalBindings = ensureMessageReferences(state, original);
  const selected = originalBindings.slice(1, 3);
  const block = applyCompression(
    state,
    originalBindings,
    protectedRefs(originalBindings),
    selected[0].ref,
    selected.at(-1).ref,
    "The original decision remains important.",
    100,
  );
  const originalOutput = transformContext(original.messages, originalBindings, state.blocks);
  assert.equal(originalOutput.filter((message) => message.content?.[0]?.text?.includes(block.id)).length, 1);
  const target = sidecarPath(sessionPath);
  persistState(target, state);

  const changed = structuredClone(original);
  const changedEntry = changed.entries.find((entry) => entry.sourceEntry.id === selected[1].entryId);
  changedEntry.messages[0] = textMessage("toolResult", "edited by context_edit; new facts " + "y".repeat(150));
  changed.entries.push({
    sourceEntry: {
      type: "context_edit",
      id: "append-only-context-edit",
      parentId: changed.entries.at(-1).sourceEntry.id,
    },
    messages: [],
  });
  changed.messages = changed.entries.flatMap((entry) => entry.messages);
  const changedBindings = ensureMessageReferences(state, changed);
  assert.equal(changedBindings[2].ref, selected[1].ref);
  const output = transformContext(changed.messages, changedBindings, state.blocks);
  assert.equal(state.blocks[0].status, "active");
  assert.equal(output.some((message) => message.content?.[0]?.text?.includes(block.id)), false);
  assert.equal(output.some((message) => message.content?.[0]?.text?.includes("edited by context_edit")), true);
  updateMetrics(state, changedBindings, new Set(), changed.messages, output);
  assert.equal(state.metrics.sourceMismatchBlockCount, 1);
  assert.equal(state.metrics.inapplicableBlockCount, 1);
  persistState(target, state);

  const reloaded = readState(target, sessionPath).state;
  const returnedToA = transformContext(original.messages, originalBindings, reloaded.blocks);
  assert.equal(returnedToA.filter((message) => message.content?.[0]?.text?.includes(block.id)).length, 1);
  assert.equal(reloaded.blocks[0].status, "active");
  rmSync(directory, { recursive: true, force: true });
});

test("off-branch blocks remain dormant and reactivate on return; unrelated blocks still apply", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-branch-"));
  const sessionPath = path.join(directory, "branch-session.jsonl");
  const state = createEmptyState(sessionPath);
  const config = { minCompressRangeChars: 100 };
  const branchA = branchProjection("A");
  const branchABindings = ensureMessageReferences(state, branchA);
  const protectedA = protectedRefs(branchABindings);
  const firstA = applyCompression(
    state, branchABindings, protectedA, branchABindings[1].ref, branchABindings[2].ref, "A phase one conclusion.", config.minCompressRangeChars,
  );

  const branchB = branchProjection("B");
  const branchBBindings = ensureMessageReferences(state, branchB);
  const protectedB = protectedRefs(branchBBindings);
  const onlyB = applyCompression(
    state, branchBBindings, protectedB, branchBBindings[1].ref, branchBBindings[2].ref, "B-only branch conclusion.", config.minCompressRangeChars,
  );
  const secondA = applyCompression(
    state, branchABindings, protectedA, branchABindings[4].ref, branchABindings[5].ref, "A phase two conclusion.", config.minCompressRangeChars,
  );

  try {
    const target = sidecarPath(sessionPath);
    persistState(target, state);
    const reloaded = readState(target, sessionPath).state;
    assert.equal(reloaded.blocks.length, 3);

    const onB = transformContext(branchB.messages, branchBBindings, reloaded.blocks);
    assert.equal(onB.filter((message) => message.content?.[0]?.text?.includes(onlyB.id)).length, 1);
    assert.equal(onB.some((message) => message.content?.[0]?.text?.includes(firstA.id)), false);
    assert.equal(onB.some((message) => message.content?.[0]?.text?.includes(secondA.id)), false);
    assert.equal(reloaded.blocks.find((item) => item.id === firstA.id).status, "active");

    const returnedA = transformContext(branchA.messages, branchABindings, reloaded.blocks);
    assert.equal(returnedA.filter((message) => message.content?.[0]?.text?.includes(firstA.id)).length, 1);
    assert.equal(returnedA.filter((message) => message.content?.[0]?.text?.includes(secondA.id)).length, 1);
    assert.equal(returnedA.some((message) => message.content?.[0]?.text?.includes(onlyB.id)), false);
    assert.equal(reloaded.blocks.filter((item) => item.status === "active").length, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("branch-specific blocks may share a source ref without suppressing the inapplicable branch source", () => {
  const sessionPath = "/shared-branch-session.jsonl";
  const state = createEmptyState(sessionPath);
  const makeBranch = (name) => {
    const entries = [];
    const append = (id, role, text) => {
      const sourceEntry = { id, parentId: entries.at(-1)?.sourceEntry.id ?? null, type: "message" };
      entries.push({ sourceEntry, messages: [textMessage(role, text)] });
    };
    append("shared-root-user", "user", "root");
    append("shared-work", "assistant", `shared work ${"s".repeat(150)}`);
    append(`${name}-work`, "toolResult", `${name} work ${"b".repeat(150)}`);
    append(`${name}-leaf-user`, "user", "latest request");
    return { entries, messages: entries.flatMap((entry) => entry.messages) };
  };
  const branchA = makeBranch("A");
  const bindingsA = ensureMessageReferences(state, branchA);
  const blockA = applyCompression(
    state, bindingsA, protectedRefs(bindingsA), bindingsA[1].ref, bindingsA[2].ref, "A branch's consumed conclusion.", 100,
  );
  const branchB = makeBranch("B");
  const bindingsB = ensureMessageReferences(state, branchB);
  const blockB = applyCompression(
    state, bindingsB, protectedRefs(bindingsB), bindingsB[1].ref, bindingsB[2].ref, "B branch's consumed conclusion.", 100,
  );

  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-shared-branch-"));
  try {
    const target = sidecarPath(path.join(directory, "session.jsonl"));
    state.session.sessionPath = path.join(directory, "session.jsonl");
    persistState(target, state);
    const reloaded = readState(target, state.session.sessionPath).state;
    assert.equal(reloaded.blocks.length, 2);
    const onA = transformContext(branchA.messages, bindingsA, reloaded.blocks);
    const onB = transformContext(branchB.messages, bindingsB, reloaded.blocks);
    assert.equal(onA.filter((message) => message.content?.[0]?.text?.includes(blockA.id)).length, 1);
    assert.equal(onA.some((message) => message.content?.[0]?.text?.includes(blockB.id)), false);
    assert.equal(onB.filter((message) => message.content?.[0]?.text?.includes(blockB.id)).length, 1);
    assert.equal(onB.some((message) => message.content?.[0]?.text?.includes(blockA.id)), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("metrics distinguish projection, eligibility, applicable blocks, effective context, and Pi usage", () => {
  const state = createEmptyState("/session.jsonl");
  const projection = fixtureProjection(8, { messageChars: 180 });
  const bindings = ensureMessageReferences(state, projection);
  const protectedRegion = computeProtectedRefs(bindings, { protectedRecentMessages: 1, protectedRecentTokens: 0 });
  const block = applyCompression(
    state, bindings, protectedRegion.refs, bindings[1].ref, bindings[2].ref, "A concise retained result.", 100,
  );
  const transformed = transformContext(projection.messages, bindings, state.blocks);
  updateMetrics(
    state,
    bindings,
    protectedRegion.refs,
    projection.messages,
    transformed,
    { tokens: 321, contextWindow: 12000 },
    {},
    DEFAULTS.nudge,
    12000,
    null,
    null,
    321,
  );
  const metrics = state.metrics;
  assert.equal(metrics.projectedModelContextMessages, projection.messages.length);
  assert.equal(metrics.projectedModelContextTokensEstimate, estimateTokens(projection.messages));
  assert.equal(metrics.compressionEligibleRawMessages, bindings.length - protectedRegion.refs.size - block.sourceMessageCount);
  assert.equal(metrics.coveredSourceMessages, block.sourceMessageCount);
  assert.equal(metrics.sourceTokensRepresentedByApplicableBlocks, block.sourceTokensEstimate);
  assert.equal(metrics.blockSummaryTokensEstimate, block.summaryTokensEstimate);
  assert.equal(metrics.effectiveTransformedContextTokensEstimate, estimateTokens(transformed));
  assert.equal(metrics.protectedMessageCount, protectedRegion.refs.size);
  assert.equal(metrics.totalBlockCount, 1);
  assert.equal(metrics.activeBlockCount, 1);
  assert.equal(metrics.piContextUsageTokens, 321);
  assert.equal(metrics.piContextWindow, 12000);
  updateMetrics(
    state,
    bindings,
    protectedRegion.refs,
    projection.messages,
    transformed,
    { tokens: 321, contextWindow: 12000 },
    {},
    DEFAULTS.nudge,
    12000,
    null,
    777,
  );
  assert.equal(state.metrics.effectiveTransformedContextTokensEstimate, 777);
});

test("manual compact queues the active model, whose tools share validated application", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-agent-compression-"));
  const sessionPath = path.join(directory, "session.jsonl");
  const source = fixtureProjection(8, { stateOnly: true, messageChars: 12000 });
  const originalTranscript = JSON.stringify(source.entries.map((entry) => entry.sourceEntry));
  const commands = new Map();
  const handlers = new Map();
  const tools = new Map();
  const sentMessages = [];
  const notices = [];
  const configPath = path.join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({
    protectedRecentMessages: 1,
    protectedRecentTokens: 0,
    minCompressRangeChars: 100,
    minSummaryRetentionPercent: 0,
  }));
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendUserMessage(message, options) { sentMessages.push({ message, options }); },
    on(name, handler) { handlers.set(name, handler); },
  };
  const priorConfig = process.env.BIG_PI_CONFIG;
  process.env.BIG_PI_CONFIG = configPath;
  const ctx = {
    sessionManager: {
      getSessionFile: () => sessionPath,
      buildSessionProjection: () => source,
    },
    getContextUsage: () => ({ tokens: 800, contextWindow: 12000, percent: 0.07 }),
    ui: { notify(message) { notices.push(message); } },
  };

  try {
    bigPi(pi);
    assert.deepEqual([...tools.keys()].sort(), ["big_pi_compress", "big_pi_compression_sources"]);
    for (const tool of tools.values()) {
      assert.equal(Array.isArray(tool.promptGuidelines), true);
      assert.equal(tool.promptGuidelines.length > 0, true);
      assert.equal(typeof tool.promptSnippet, "string");
      assert.equal(tool.promptSnippet.trim().length > 0, true);
    }
    await handlers.get("session_start")({ reason: "startup" }, ctx);
    await commands.get("big-pi").handler("compact", ctx);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].options.deliverAs, "followUp");
    assert.match(sentMessages[0].message, /big_pi_compression_sources/);
    assert.match(sentMessages[0].message, /big_pi_compress/);
    const sourcesResult = await tools.get("big_pi_compression_sources").execute("call-1", {}, undefined, undefined, ctx);
    const candidates = JSON.parse(sourcesResult.content[0].text);
    assert.equal(candidates.eligibleRanges[0].sourceChars >= 100, true);
    const range = candidates.eligibleRanges[0];
    const eligibleMessages = source.messages.filter((message) => message.role !== "user");
    const originalSourceText = eligibleMessages.map((message) => message.content[0].text).join("");
    assert.equal(sourcesResult.content[0].text.length < originalSourceText.length / 10, true);
    assert.equal(eligibleMessages.every((message) => !sourcesResult.content[0].text.includes(message.content[0].text)), true);
    assert.deepEqual(range.sources.map((item) => item.ref), ["M000002", "M000003", "M000004", "M000005", "M000006", "M000007"]);
    assert.deepEqual(range.sources.map((item) => item.role), ["assistant", "toolResult", "assistant", "toolResult", "assistant", "toolResult"]);
    assert.equal(range.sources.every((item) => item.preview.length <= 140), true);
    assert.equal(range.sources[0].sourceChars >= 12000, true);
    assert.equal(range.sources[0].role, "assistant");
    assert.equal(range.sources.every((item) => !Object.hasOwn(item, "content")), true);
    const summary = "Keep the durable requirements, implementation decision, and verification status.";
    const applied = await tools.get("big_pi_compress").execute("call-2", {
      startRef: range.sources[0].ref,
      endRef: range.sources[1].ref,
      summary,
    }, undefined, undefined, ctx);
    assert.equal(applied.isError, undefined);
    assert.match(applied.content[0].text, /Compression applied as B000001/);
    const sidecar = readState(sidecarPath(sessionPath), sessionPath).state;
    assert.equal(sidecar.blocks.length, 1);
    assert.equal(sidecar.metrics.activeBlockCount, 1);

    const mismatched = [...source.messages];
    [mismatched[1], mismatched[2]] = [mismatched[2], mismatched[1]];
    const failedOpen = handlers.get("context")({ messages: mismatched }, ctx);
    assert.strictEqual(failedOpen.messages, mismatched);
    const noticesBeforeRepeat = notices.length;
    const failedAgain = handlers.get("context")({ messages: mismatched }, ctx);
    assert.strictEqual(failedAgain.messages, mismatched);
    assert.equal(notices.length, noticesBeforeRepeat);

    const resumed = handlers.get("context")({ messages: source.messages }, ctx);
    assert.equal(resumed.messages.filter((message) => message.content?.[0]?.text?.includes("big-pi compressed context")).length, 1, JSON.stringify(resumed.messages.map((message) => message.content?.[0]?.text).slice(0, 3)));
    assert.equal(JSON.stringify(source.entries.map((entry) => entry.sourceEntry)), originalTranscript);
    assert.equal(notices.some((notice) => notice.includes("Queued an active-agent compression turn")), true, JSON.stringify(notices));
  } finally {
    if (priorConfig === undefined) delete process.env.BIG_PI_CONFIG;
    else process.env.BIG_PI_CONFIG = priorConfig;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("registered compression tool contract distinguishes raw and hierarchy requests and guides recovery", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-tool-contract-"));
  const projection = fixtureProjection(8, { messageChars: 12000 });
  const harness = extensionHarness(directory, () => projection);
  try {
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const tool = harness.tools.get("big_pi_compress");
    assert.match(tool.description, /Always provide your own non-empty summary/);
    assert.match(tool.description, /big_pi_compression_sources/);
    assert.deepEqual(tool.parameters.required, ["summary"]);
    assert.deepEqual(tool.parameters.oneOf, [
      { required: ["candidateId"] },
      { required: ["startRef", "endRef"] },
      { required: ["sourceBlockIds"] },
    ]);
    assert.match(tool.parameters.properties.candidateId.description, /candidateId/);
    assert.match(tool.parameters.properties.startRef.description, /sourceType=raw/);
    assert.match(tool.parameters.properties.endRef.description, /same returned eligible range/);
    assert.match(tool.parameters.properties.sourceBlockIds.description, /one returned candidate/);
    assert.match(tool.parameters.properties.summary.description, /Always required/);
    const guidance = tool.promptGuidelines.join("\n");
    assert.match(guidance, /big_pi_compression_sources/);
    assert.match(guidance, /candidateId/);
    assert.match(guidance, /protected messages/);

    const listed = await harness.tools.get("big_pi_compression_sources")
      .execute("discover", { sourceType: "raw" }, undefined, undefined, harness.ctx);
    const range = JSON.parse(listed.content[0].text).eligibleRanges[0];
    assert.ok(range);
    assert.match(range.candidateId, /^C-[a-f0-9]{16}$/);
    assert.ok(range.recommendedSummaryTokens >= range.minimumSummaryTokens);
    const startRef = range.sources[0].ref;
    const endRef = range.sources[1].ref;
    const invoke = (args) => tool.execute("invalid-contract", args, undefined, undefined, harness.ctx);
    const rejected = [
      [{ endRef, summary: "summary" }, /startRef is missing/],
      [{ startRef, summary: "summary" }, /endRef is missing/],
      [{ startRef, endRef }, /summary is required/],
      [{ summary: "summary" }, /provide startRef and endRef/],
      [{ startRef, endRef, sourceBlockIds: ["B000001", "B000002"], summary: "summary" }, /choose exactly one source form/],
      [{ startRef: "M999999", endRef: "M999998", summary: "summary" }, /active projection|source/i],
      [{ startRef: "M000001", endRef: "M000002", summary: "summary" }, /protected/i],
    ];
    for (const [args, reason] of rejected) {
      const result = await invoke(args);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, reason);
      assert.match(result.content[0].text, /big_pi_compression_sources/);
      assert.match(result.content[0].text, /do not repeat identical invalid arguments/i);
    }
    assert.equal(readState(sidecarPath(harness.sessionPath), harness.sessionPath).state.blocks.length, 0);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("candidateId applies exactly one currently eligible raw range", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-candidate-id-"));
  const projection = fixtureProjection(8, { messageChars: 12000 });
  const harness = extensionHarness(directory, () => projection);
  try {
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const listed = await harness.tools.get("big_pi_compression_sources")
      .execute("discover", { sourceType: "raw" }, undefined, undefined, harness.ctx);
    const candidate = JSON.parse(listed.content[0].text).eligibleRanges[0];
    assert.ok(candidate?.candidateId);
    const applied = await harness.tools.get("big_pi_compress").execute("candidate", {
      candidateId: candidate.candidateId,
      summary: "Preserve the requirements, decisions, observed results, and remaining work. ".repeat(120),
    }, undefined, undefined, harness.ctx);
    assert.equal(applied.isError, undefined, applied.content[0].text);
    assert.match(applied.content[0].text, /Compression applied as B000001/);
    assert.equal(readState(sidecarPath(harness.sessionPath), harness.sessionPath).state.blocks.length, 1);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a discovered candidate survives session growth before compression and is revalidated", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-candidate-growth-"));
  const projection = fixtureProjection(8, { messageChars: 12000 });
  const harness = extensionHarness(directory, () => projection);
  try {
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const listed = await harness.tools.get("big_pi_compression_sources")
      .execute("discover", { sourceType: "raw" }, undefined, undefined, harness.ctx);
    const candidate = JSON.parse(listed.content[0].text).eligibleRanges[0];
    const parentId = projection.entries.at(-1).sourceEntry.id;
    const followUp = textMessage("user", "Continue with the next task.");
    const entry = {
      sourceEntry: { type: "message", id: "candidate-growth-follow-up", parentId, message: followUp },
      messages: [followUp],
    };
    projection.entries.push(entry);
    projection.messages.push(followUp);
    const currentCandidates = JSON.parse((await harness.tools.get("big_pi_compression_sources")
      .execute("refresh", { sourceType: "raw" }, undefined, undefined, harness.ctx)).content[0].text).eligibleRanges;
    assert.ok(!currentCandidates.some((item) => item.candidateId === candidate.candidateId),
      "new session content changes the maximal candidate ID after discovery");

    const applied = await harness.tools.get("big_pi_compress").execute("candidate", {
      candidateId: candidate.candidateId,
      summary: "Preserve the requirements, decisions, observed results, and remaining work. ".repeat(120),
    }, undefined, undefined, harness.ctx);
    assert.equal(applied.isError, undefined, applied.content[0].text);
    assert.match(applied.content[0].text, /Compression applied as B000001/);
    assert.equal(readState(sidecarPath(harness.sessionPath), harness.sessionPath).state.blocks.length, 1);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stale candidateId is rejected with a fresh discovery instruction", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-stale-candidate-"));
  const projection = fixtureProjection(8, { messageChars: 12000 });
  const harness = extensionHarness(directory, () => projection);
  try {
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const listed = await harness.tools.get("big_pi_compression_sources")
      .execute("discover", { sourceType: "raw" }, undefined, undefined, harness.ctx);
    const candidate = JSON.parse(listed.content[0].text).eligibleRanges[0];
    const invalid = await harness.tools.get("big_pi_compress").execute("stale", {
      candidateId: "C-0000000000000000",
      summary: "Preserve decisions, results, and remaining work.",
    }, undefined, undefined, harness.ctx);
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /candidate is stale/i);
    assert.match(invalid.content[0].text, /refresh big_pi_compression_sources/i);
    assert.ok(candidate.candidateId);
    assert.equal(readState(sidecarPath(harness.sessionPath), harness.sessionPath).state.blocks.length, 0);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compression rejection explains the summary target and safe recovery", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-summary-recovery-"));
  const projection = fixtureProjection(8, { messageChars: 12000 });
  const harness = extensionHarness(directory, () => projection, {
    minCompressRangeChars: 1,
    minSummaryRetentionPercent: 40,
  });
  try {
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const listed = await harness.tools.get("big_pi_compression_sources")
      .execute("discover", { sourceType: "raw" }, undefined, undefined, harness.ctx);
    const candidate = JSON.parse(listed.content[0].text).eligibleRanges[0];
    assert.ok(candidate.minimumSummaryTokens > 0);
    const rejected = await harness.tools.get("big_pi_compress").execute("too-short", {
      startRef: candidate.startRef,
      endRef: candidate.endRef,
      summary: "Brief.",
    }, undefined, undefined, harness.ctx);
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /minimum \d+ tokens at 40%/);
    assert.match(rejected.content[0].text, /aim for \d+ or more/);
    assert.match(rejected.content[0].text, /concrete preserved facts, decisions, results, and open work/);
    assert.match(rejected.content[0].text, /fresh values/);
    assert.equal(readState(sidecarPath(harness.sessionPath), harness.sessionPath).state.blocks.length, 0);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("registered compression tool rejects stale block IDs with fresh-discovery guidance", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-stale-block-tool-"));
  const projection = fixtureProjection(8, { messageChars: 12000 });
  const harness = extensionHarness(directory, () => projection, {
    hierarchy: { enabled: true, minBlocksPerPromotion: 2 },
  });
  try {
    const state = createEmptyState(harness.sessionPath);
    const bindings = ensureMessageReferences(state, projection);
    const blocks = createTier1Blocks(state, projection, bindings, 2, 2);
    blocks[0].status = "stale";
    blocks[0].staleReason = "source lineage changed";
    persistState(sidecarPath(harness.sessionPath), state);
    await harness.handlers.get("session_start")({ reason: "resume" }, harness.ctx);

    const result = await harness.tools.get("big_pi_compress").execute("stale-promotion", {
      sourceBlockIds: blocks.map((block) => block.id),
      summary: "Preserve the completed phase decisions and results.",
    }, undefined, undefined, harness.ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /active lifecycle|stale/i);
    assert.match(result.content[0].text, /big_pi_compression_sources/);
    assert.equal(readState(sidecarPath(harness.sessionPath), harness.sessionPath).state.blocks.length, 2);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("empty sessions defer sidecar creation and empty projections preserve existing compression state", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-sidecar-lifecycle-"));
  let projection = { entries: [], messages: [] };
  let activePath = path.join(directory, "session-a.jsonl");
  const harness = extensionHarness(directory, () => projection, {
    getSessionPath: () => activePath,
  });
  const sidecarA = sidecarPath(activePath);
  const sidecarB = sidecarPath(path.join(directory, "session-b.jsonl"));
  try {
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    assert.equal(existsSync(sidecarA), false);
    const originalEmptyMessages = projection.messages;
    const emptyContext = harness.handlers.get("context")({ messages: originalEmptyMessages }, harness.ctx);
    assert.deepEqual(emptyContext.messages, originalEmptyMessages);
    assert.equal(existsSync(sidecarA), false);

    projection = fixtureProjection(8, { messageChars: 12000 });
    await harness.handlers.get("session_start")({ reason: "first user message" }, harness.ctx);
    assert.equal(existsSync(sidecarA), true);
    const sources = await harness.tools.get("big_pi_compression_sources")
      .execute("raw", { sourceType: "raw" }, undefined, undefined, harness.ctx);
    const range = JSON.parse(sources.content[0].text).eligibleRanges[0];
    const applied = await harness.tools.get("big_pi_compress").execute("compress", {
      startRef: range.startRef,
      endRef: range.endRef,
      summary: "Preserve the completed work and its durable results.",
    }, undefined, undefined, harness.ctx);
    assert.equal(applied.isError, undefined);
    const compressedSidecar = readState(sidecarA, activePath).state;
    assert.equal(compressedSidecar.blocks.length, 1);
    const persistedAfterCompression = readFileSync(sidecarA, "utf8");

    activePath = path.join(directory, "session-b.jsonl");
    projection = { entries: [], messages: [] };
    await harness.handlers.get("session_start")({ reason: "provisional session" }, harness.ctx);
    assert.equal(existsSync(sidecarB), false);
    projection = fixtureProjection(5, { messageChars: 3000 });
    await harness.handlers.get("session_start")({ reason: "second active session" }, harness.ctx);
    assert.equal(existsSync(sidecarA), true);
    assert.equal(existsSync(sidecarB), true);

    activePath = path.join(directory, "session-a.jsonl");
    projection = { entries: [], messages: [] };
    await harness.handlers.get("session_start")({ reason: "resume with empty projection" }, harness.ctx);
    assert.equal(readFileSync(sidecarA, "utf8"), persistedAfterCompression);
    const emptyAfterResume = harness.handlers.get("context")({ messages: [] }, harness.ctx);
    assert.deepEqual(emptyAfterResume.messages, []);
    assert.equal(readFileSync(sidecarA, "utf8"), persistedAfterCompression);
    assert.equal(readState(sidecarA, activePath).state.blocks.length, 1);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed atomic compression persistence does not report or retain an unapplied block", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-sidecar-interrupted-"));
  const projection = fixtureProjection(8, { messageChars: 12000 });
  let usageCalls = 0;
  let interrupted = false;
  let sessionPath;
  const harness = extensionHarness(directory, () => projection, {
    getContextUsage: () => {
      usageCalls++;
      if (!interrupted && usageCalls === 4) {
        const sidecar = sidecarPath(sessionPath);
        renameSync(sidecar, `${sidecar}.saved`);
        mkdirSync(sidecar);
        interrupted = true;
      }
      return { tokens: 800, contextWindow: 12000, percent: 0.07 };
    },
  });
  sessionPath = harness.sessionPath;
  const sidecar = sidecarPath(sessionPath);
  try {
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const sources = await harness.tools.get("big_pi_compression_sources")
      .execute("raw", { sourceType: "raw" }, undefined, undefined, harness.ctx);
    const range = JSON.parse(sources.content[0].text).eligibleRanges[0];
    const result = await harness.tools.get("big_pi_compress").execute("interrupted", {
      startRef: range.startRef,
      endRef: range.endRef,
      summary: "Preserve the completed work and its durable results.",
    }, undefined, undefined, harness.ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Compression not applied/);
    assert.equal(readState(`${sidecar}.saved`, sessionPath).state.blocks.length, 0);
    const hasTemporary = (folder) => readdirSync(folder, { withFileTypes: true }).some((entry) =>
      entry.isDirectory()
        ? hasTemporary(path.join(folder, entry.name))
        : entry.name.endsWith(".tmp"),
    );
    assert.equal(hasTemporary(directory), false);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("model-facing block discovery and promotion are advisory, tier-specific, and nonsuppressing to raw compression", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-hierarchy-tools-"));
  const projection = fixtureProjection(20, { messageChars: 900 });
  const harness = extensionHarness(directory, () => projection, {
    hierarchy: {
      enabled: true,
      minBlocksPerPromotion: 3,
      tier2NudgeSummaryTokens: 190,
      tier3NudgeSummaryTokens: 10,
    },
  });
  try {
    const transcript = projection.entries.map((entry) => JSON.stringify(entry.sourceEntry)).join("\n") + "\n";
    writeFileSync(harness.sessionPath, transcript);
    const state = createEmptyState(harness.sessionPath);
    const bindings = ensureMessageReferences(state, projection);
    const tier1 = createTier1Blocks(state, projection, bindings, 3, 3);
    state.compression.hierarchy.tier2NudgeSummaryTokens = 190;
    state.compression.hierarchy.tier3NudgeSummaryTokens = 10;
    let transformed = transformContext(projection.messages, bindings, state.blocks);
    updateMetrics(state, bindings, new Set(), projection.messages, transformed);
    assert.equal(state.metrics.tier2PromotionDue, false);

    for (let index = 3; index < 5; index++) {
      const start = 1 + index * 3;
      applyCompression(
        state,
        bindings,
        protectedRefs(bindings),
        bindings[start].ref,
        bindings[start + 2].ref,
        `Phase ${index + 1}: preserve the durable implementation decisions, current state, unresolved requirements, and verified tests for this completed work period.`,
        100,
      );
    }
    transformed = transformContext(projection.messages, bindings, state.blocks);
    updateMetrics(state, bindings, new Set(), projection.messages, transformed);
    assert.equal(state.metrics.tier2PromotionDue, true);
    persistState(sidecarPath(harness.sessionPath), state);
    const above = harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx);
    assert.match(above.systemPrompt, /Tier-1 active applicable summary mass/);
    assert.match(above.systemPrompt, /contiguous run/);
    const repeated = harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx);
    assert.equal(repeated, undefined);
    assert.equal(tier1.length, 3);

    const listed = await harness.tools.get("big_pi_compression_sources")
      .execute("blocks", { sourceType: "blocks", tier: 1 }, undefined, undefined, harness.ctx);
    const candidates = JSON.parse(listed.content[0].text).candidates;
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].sourceBlockIds.length, 5);
    assert.match(candidates[0].candidateId, /^C-[a-f0-9]{16}$/);
    assert.ok(candidates[0].recommendedSummaryTokens >= candidates[0].minimumSummaryTokens);
    const promoted = await harness.tools.get("big_pi_compress").execute("promote", {
      candidateId: candidates[0].candidateId,
      summary: "Consolidate durable requirements, architecture, implementation state, unresolved work, and test results.",
    }, undefined, undefined, harness.ctx);
    assert.equal(promoted.isError, undefined);
    assert.match(promoted.content[0].text, /tier 2/);

    const rawSources = await harness.tools.get("big_pi_compression_sources")
      .execute("raw", { sourceType: "raw" }, undefined, undefined, harness.ctx);
    assert.ok(JSON.parse(rawSources.content[0].text).eligibleRanges.length > 0);
    const tier3Advisory = harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx);
    assert.match(tier3Advisory.systemPrompt, /Tier-2 active applicable summary mass/);
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx), undefined);
    await harness.commands.get("big-pi").handler("status", harness.ctx);
    assert.match(harness.notices.at(-1), /Tier-2 active blocks:\s+1/);
    assert.match(harness.notices.at(-1), /Tier-3 promotion due:\s+yes/);
    assert.equal(readFileSync(harness.sessionPath, "utf8"), transcript);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("transient context correlation failures fail open once and recover on the next request", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-recovery-"));
  const sessionPath = path.join(directory, "session.jsonl");
  const source = fixtureProjection(6, { messageChars: 300 });
  const handlers = new Map();
  const notices = [];
  const configPath = path.join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({ minCompressRangeChars: 100 }));
  const previous = process.env.BIG_PI_CONFIG;
  process.env.BIG_PI_CONFIG = configPath;
  try {
    bigPi({
      registerTool() {},
      registerCommand() {},
      on(name, handler) { handlers.set(name, handler); },
    });
    const ctx = {
      sessionManager: { getSessionFile: () => sessionPath, buildSessionProjection: () => source },
      ui: { notify(message) { notices.push(message); } },
    };
    handlers.get("session_start")({}, ctx);
    const mismatch = [source.messages[0], source.messages[2], source.messages[1], ...source.messages.slice(3)];
    const failed = handlers.get("context")({ messages: mismatch }, ctx);
    assert.strictEqual(failed.messages, mismatch);
    const recovered = handlers.get("context")({ messages: source.messages }, ctx);
    assert.deepEqual(recovered.messages, source.messages);
    assert.equal(notices.filter((notice) => notice.includes("failed open")).length, 1);
  } finally {
    if (previous === undefined) delete process.env.BIG_PI_CONFIG;
    else process.env.BIG_PI_CONFIG = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("threshold compaction is yielded after one unproductive interception and manual compaction queues Big Pi", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-native-compact-"));
  const projection = fixtureProjection(8, { messageChars: 240 });
  const harness = extensionHarness(directory, () => projection);
  const transcript = projection.entries.map((entry) => JSON.stringify(entry.sourceEntry)).join("\n") + "\n";
  try {
    writeFileSync(harness.sessionPath, transcript);
    const state = createEmptyState(harness.sessionPath);
    const bindings = ensureMessageReferences(state, projection);
    const block = applyCompression(
      state,
      bindings,
      protectedRefs(bindings),
      bindings[1].ref,
      bindings[2].ref,
      "Keep the durable decision from the earlier work.",
      1,
    );
    persistState(sidecarPath(harness.sessionPath), state);
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);

    const persistedBefore = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    const compact = harness.handlers.get("session_before_compact");
    assert.equal(harness.handlerRegistrations.get("session_before_compact").length, 1);
    assert.deepEqual(compact({ reason: "threshold", willRetry: false }, harness.ctx), { cancel: true });
    assert.equal(compact({ reason: "threshold", willRetry: false }, harness.ctx), undefined,
      "a repeated threshold request without a committed Big Pi block must yield to Pi");
    assert.equal(compact({ reason: "overflow", willRetry: true }, harness.ctx), undefined);
    assert.deepEqual(compact({ reason: "manual", willRetry: false }, harness.ctx), { cancel: true });
    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0].message, /Please compress one completed/);

    assert.equal(harness.handlerRegistrations.get("session_before_compact").length, 1);
    assert.equal(readFileSync(harness.sessionPath, "utf8"), transcript);
    const persistedAfter = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    assert.deepEqual(persistedAfter.blocks, [block]);
    assert.deepEqual(persistedAfter.compression.growth, persistedBefore.compression.growth);
    assert.deepEqual(persistedAfter.compression.percentage, persistedBefore.compression.percentage);
    assert.equal(persistedAfter.compression.emergency.projections[
      persistedAfter.metrics.growthProjectionId
    ].lastOutcome, "fallback-pending");
    assert.match(persistedAfter.compression.emergency.projections[
      persistedAfter.metrics.growthProjectionId
    ].lastReason, /Repeated Pi threshold compaction/);
    assert.equal(persistedAfter.compression.emergency.projections[
      persistedAfter.metrics.growthProjectionId
    ].nativeFallbackState, "pending");
    assert.equal(harness.sentMessages.length, 1, "manual Pi compact should queue Big Pi compression");
    assert.equal(harness.tools.has("big_pi_compress"), true);

    await harness.commands.get("big-pi").handler("status", harness.ctx);
    const status = harness.notices.at(-1);
    assert.match(status, /State:\s+active/);
    assert.match(status, /Compaction owner:\s+Pi/);
    assert.match(status, /Pi native compaction:\s+allowed/);
    assert.match(status, /Native compact attempts:\s+4/);
    assert.match(status, /Native compactions cancelled:\s+2/);
    assert.match(status, /Last native compact attempt:\s+\d{4}-/);
    assert.match(status, /Last interception result:\s+cancelled; Big Pi compression queued/);
    assert.match(status, /Last emergency outcome:\s+fallback-pending/);
    assert.equal(harness.notices.some((notice) => notice.includes("yielded this overflow")), false,
      "Pi already owns fallback after the repeated threshold event");

    harness.handlers.get("session_compact")({
      reason: "overflow",
      fromExtension: false,
      willRetry: true,
    }, harness.ctx);
    await harness.commands.get("big-pi").handler("status", harness.ctx);
    assert.match(harness.notices.at(-1), /Compaction owner:\s+big-pi/);
    assert.match(harness.notices.at(-1), /Pi fallback completed; big-pi ownership resumed/);
    assert.equal(readState(sidecarPath(harness.sessionPath), harness.sessionPath).state
      .compression.emergency.projections[persistedAfter.metrics.growthProjectionId].lastOutcome, "fallback-completed");

    await harness.commands.get("big-pi").handler("compact", harness.ctx);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0].delivery.deliverAs, "followUp");
    assert.match(harness.sentMessages[0].message, /big_pi_compression_sources/);
    assert.equal(readFileSync(harness.sessionPath, "utf8"), transcript);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Pi threshold just below a percentage checkpoint delivers the pending Big Pi nudge first", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-threshold-nudge-"));
  const projection = fixtureProjection(12, { messageChars: 1800 });
  const tokens = estimateTokens(projection.messages);
  const contextWindow = windowForUsage(projection, 79.6);
  const harness = extensionHarness(directory, () => projection, {
    nudge: { mode: "percentage", thresholdPercentage: 80, repeatEveryPercentage: 5 },
    getContextUsage: () => ({ tokens, contextWindow }),
  });
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    const compact = harness.handlers.get("session_before_compact");
    assert.deepEqual(compact({ reason: "threshold", willRetry: false }, harness.ctx), { cancel: true });

    const guidance = harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx);
    assert.ok(guidance, JSON.stringify(readState(sidecarPath(harness.sessionPath), harness.sessionPath).state.metrics));
    assert.match(guidance.systemPrompt, /native threshold compaction at 79\.6% used/);
    assert.match(guidance.systemPrompt, /pending 80% Big Pi checkpoint advisory/);

    const state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    const cadence = state.compression.percentage.projections[state.metrics.growthProjectionId];
    assert.equal(cadence.lastDeliveredCheckpointPercentage, 80);
    assert.equal(cadence.nextCheckpointPercentage, 85);
    assert.equal(compact({ reason: "threshold", willRetry: false }, harness.ctx), undefined,
      "once the advisory has been delivered, an unproductive repeated native request must fall back to Pi");
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("successful Pi fallback resumes big-pi ownership across restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-fallback-restart-"));
  const projection = fixtureProjection(12, { messageChars: 1800 });
  const transcript = projection.entries.map((entry) => JSON.stringify(entry.sourceEntry)).join("\n") + "\n";
  const contextWindow = windowForUsage(projection, 96);
  const options = {
    emergency: { enabled: true, maxAttemptsPerTurn: 1 },
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow }),
  };
  const first = extensionHarness(directory, () => projection, options);
  try {
    writeFileSync(first.sessionPath, transcript);
    await first.handlers.get("session_start")({ reason: "startup" }, first.ctx);
    reportProviderUsage(first, estimateTokens(projection.messages));
    const compact = first.handlers.get("session_before_compact");
    assert.deepEqual(compact({ reason: "overflow", willRetry: true }, first.ctx), { cancel: true });
    first.handlers.get("before_agent_start")({ systemPrompt: "" }, first.ctx);
    await first.handlers.get("agent_end")({}, first.ctx);
    assert.equal(compact({ reason: "overflow", willRetry: true }, first.ctx), undefined);
    let state = readState(sidecarPath(first.sessionPath), first.sessionPath).state;
    let record = state.compression.emergency.projections[state.metrics.growthProjectionId];
    assert.equal(record.nativeFallbackState, "pending");
    assert.equal(record.lastOutcome, "fallback-pending");

    first.handlers.get("session_compact")({
      reason: "overflow",
      fromExtension: false,
      willRetry: true,
    }, first.ctx);
    state = readState(sidecarPath(first.sessionPath), first.sessionPath).state;
    record = state.compression.emergency.projections[state.metrics.growthProjectionId];
    assert.equal(record.nativeFallbackState, "completed");
    assert.equal(record.lastOutcome, "fallback-completed");
    assert.deepEqual(compact({ reason: "threshold", willRetry: false }, first.ctx), { cancel: true });
    const resumedAfterCompact = first.handlers.get("before_agent_start")({ systemPrompt: "resume task" }, first.ctx);
    assert.match(resumedAfterCompact.systemPrompt, /old Big Pi compression request is superseded/);
    const blockedRetry = first.handlers.get("tool_call")({ toolName: "big_pi_compress" }, first.ctx);
    assert.equal(blockedRetry.block, true);
    assert.match(blockedRetry.reason, /native compaction already completed/);
    reportProviderUsage(first, Math.floor(contextWindow * 0.35));
    assert.equal(first.handlers.get("before_agent_start")({ systemPrompt: "resume task" }, first.ctx), undefined,
      "after fresh low usage arrives, normal task continuation should not receive stale emergency guidance");
    assert.equal(first.handlers.get("tool_call")({ toolName: "big_pi_compress" }, first.ctx), undefined,
      "fresh provider usage releases stale-retry suppression");
    await first.commands.get("big-pi").handler("status", first.ctx);
    assert.match(first.notices.at(-1), /Compaction owner:\s+big-pi/);
    assert.match(first.notices.at(-1), /Pi fallback completed; big-pi ownership resumed/);

    const restarted = extensionHarness(directory, () => projection, options);
    await restarted.handlers.get("session_start")({ reason: "resume" }, restarted.ctx);
    assert.deepEqual(
      restarted.handlers.get("session_before_compact")({ reason: "manual", willRetry: false }, restarted.ctx),
      { cancel: true },
    );
    await restarted.commands.get("big-pi").handler("status", restarted.ctx);
    const status = restarted.notices.at(-1);
    assert.match(status, /Compaction owner:\s+big-pi/);
    assert.match(status, /Native fallback state:\s+completed/);
    assert.doesNotMatch(status, /Pi owns compaction|Pi owns fallback/);
    assert.equal(readFileSync(first.sessionPath, "utf8"), transcript);
  } finally {
    restoreHarnessConfig(first);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native compaction waits for fresh provider usage before judging emergency pressure", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-post-compact-usage-"));
  const projection = fixtureProjection(12, { messageChars: 1800 });
  const contextWindow = windowForUsage(projection, 96);
  const harness = extensionHarness(directory, () => projection, {
    emergency: { enabled: true },
    getContextUsage: () => ({ tokens: Math.ceil(contextWindow * 0.96), contextWindow }),
  });
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    reportProviderUsage(harness, Math.ceil(contextWindow * 0.96));
    const compact = harness.handlers.get("session_before_compact");
    assert.deepEqual(compact({ reason: "overflow", willRetry: true }, harness.ctx), { cancel: true });
    harness.handlers.get("session_compact")({ reason: "overflow" }, harness.ctx);

    harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx);
    let state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    assert.equal(state.metrics.piContextUsageTokens, null,
      "stale pre-compaction provider tokens and saved metrics must both be discarded");
    assert.equal(state.metrics.currentUsedPercentage, null,
      "a stale contextUsage report must not restart percentage pressure checks");

    reportProviderUsage(harness, Math.ceil(contextWindow * 0.35));
    harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx);
    state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    assert.equal(state.metrics.piContextUsageTokens, Math.ceil(contextWindow * 0.35),
      "the next provider turn supplies the fresh post-compaction measurement");
    assert.ok(state.metrics.currentUsedPercentage < 85,
      "fresh post-compaction usage is evaluated against the configured emergency threshold");
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pending Pi fallback remains protected from refresh and estimator changes", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-fallback-pending-"));
  const projection = fixtureProjection(12, { messageChars: 1800 });
  let contextWindow = windowForUsage(projection, 96);
  const harness = extensionHarness(directory, () => projection, {
    emergency: { enabled: true, maxAttemptsPerTurn: 1 },
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow }),
  });
  try {
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const compact = harness.handlers.get("session_before_compact");
    assert.deepEqual(compact({ reason: "overflow", willRetry: true }, harness.ctx), { cancel: true });
    harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    await harness.handlers.get("agent_end")({}, harness.ctx);
    assert.equal(compact({ reason: "overflow", willRetry: true }, harness.ctx), undefined);

    const effective = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state
      .metrics.effectiveTransformedContextTokensEstimate;
    contextWindow = effective * 2;
    await harness.commands.get("big-pi").handler("status", harness.ctx);
    assert.match(harness.notices.at(-1), /Compaction owner:\s+Pi/);
    assert.match(harness.notices.at(-1), /Native fallback state:\s+pending/);
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx), undefined);
    assert.equal(compact({ reason: "threshold", willRetry: false }, harness.ctx), undefined);
    await harness.commands.get("big-pi").handler("status", harness.ctx);
    assert.match(harness.notices.at(-1), /Compaction owner:\s+Pi/);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed Pi fallback can be repaired by manual Tier-1 compression", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-fallback-repair-"));
  const projection = fixtureProjection(12, { messageChars: 4000 });
  const transcript = projection.entries.map((entry) => JSON.stringify(entry.sourceEntry)).join("\n") + "\n";
  const contextWindow = windowForUsage(projection, 96);
  const harness = extensionHarness(directory, () => projection, {
    emergency: { enabled: true, maxAttemptsPerTurn: 1 },
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow }),
  });
  try {
    writeFileSync(harness.sessionPath, transcript);
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const compact = harness.handlers.get("session_before_compact");
    assert.deepEqual(compact({ reason: "overflow", willRetry: true }, harness.ctx), { cancel: true });
    harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    await harness.handlers.get("agent_end")({}, harness.ctx);
    assert.equal(compact({ reason: "overflow", willRetry: true }, harness.ctx), undefined);
    harness.handlers.get("session_compact_failed")({
      reason: "overflow",
      fromExtension: false,
      aborted: true,
      willRetry: false,
    }, harness.ctx);

    let state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    let record = state.compression.emergency.projections[state.metrics.growthProjectionId];
    assert.equal(record.nativeFallbackState, "failed");
    assert.equal(record.lastOutcome, "fallback-failed");
    await harness.commands.get("big-pi").handler("status", harness.ctx);
    assert.match(harness.notices.at(-1), /Compaction owner:\s+Pi/);
    assert.match(harness.notices.at(-1), /Pi fallback failed; Pi owns compaction/);

    await harness.commands.get("big-pi").handler("compact", harness.ctx);
    assert.equal(harness.sentMessages.at(-1).delivery.deliverAs, "followUp");
    const compress = harness.tools.get("big_pi_compress");
    for (let attempt = 0; attempt < 8; attempt++) {
      state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
      if (state.metrics.effectiveTransformedContextTokensEstimate <= Math.floor(contextWindow * 0.7)) break;
      const listed = await harness.tools.get("big_pi_compression_sources")
        .execute("sources", {}, undefined, undefined, harness.ctx);
      const range = JSON.parse(listed.content[0].text).eligibleRanges[0];
      assert.ok(range, "manual repair should expose another eligible Tier-1 range");
      const result = await compress.execute("repair", {
        startRef: range.startRef,
        endRef: range.endRef,
        summary: "Preserve the durable completed work and its verification.",
      }, undefined, undefined, harness.ctx);
      assert.equal(result.isError, undefined);
    }

    state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    record = state.compression.emergency.projections[state.metrics.growthProjectionId];
    assert.equal(state.metrics.effectiveTransformedContextTokensEstimate <= Math.floor(contextWindow * 0.7), true);
    reportProviderUsage(harness, state.metrics.effectiveTransformedContextTokensEstimate);
    harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    record = state.compression.emergency.projections[state.metrics.growthProjectionId];
    assert.equal(record.lastOutcome, "recovered");
    assert.equal(record.nativeFallbackState, "none");
    assert.match(harness.notices.findLast((notice) => notice.includes("recovered overflow context")), /continuing the active task/);
    assert.deepEqual(compact({ reason: "threshold", willRetry: false }, harness.ctx), { cancel: true });
    assert.equal(readFileSync(harness.sessionPath, "utf8"), transcript);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pre-overflow pressure requests bounded high-priority compression and recovers through Tier-1", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-pressure-recovery-"));
  const projection = fixtureProjection(12, { messageChars: 1800 });
  const transcript = projection.entries.map((entry) => JSON.stringify(entry.sourceEntry)).join("\n") + "\n";
  const contextWindow = windowForUsage(projection, 96);
  const harness = extensionHarness(directory, () => projection, {
    emergency: { enabled: true },
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow }),
  });
  try {
    writeFileSync(harness.sessionPath, transcript);
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const before = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    const request = harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx);
    assert.match(request.systemPrompt, /big-pi emergency pressure \(attempt 1\/2\)/);
    assert.match(request.systemPrompt, /96\.\d% used/);
    assert.match(request.systemPrompt, /target is 70%/);
    assert.match(request.systemPrompt, /reclaim needed is about/);
    assert.match(request.systemPrompt, /"sourceType":"raw"/);
    assert.match(request.systemPrompt, /candidateId/);
    assert.match(request.systemPrompt, /big_pi_compression_sources/);
    assert.match(request.systemPrompt, /do not repeat identical arguments/);
    assert.match(request.systemPrompt, /resume the user's task automatically/i);
    assert.match(request.systemPrompt, /without asking the user to resubmit/i);
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx), undefined);

    const sourcesResult = await harness.tools.get("big_pi_compression_sources").execute("sources", {}, undefined, undefined, harness.ctx);
    const index = JSON.parse(sourcesResult.content[0].text);
    assert.equal(index.emergency.pressureState, "PRESSURE");
    assert.equal(index.emergency.estimatedReclaimTokens > 0, true);
    assert.equal(index.eligibleRanges.length > 0, true);
    const selected = index.eligibleRanges[0];
    const applied = await harness.tools.get("big_pi_compress").execute("compress", {
      startRef: selected.startRef,
      endRef: selected.endRef,
      summary: "Preserve the completed decisions, durable requirements, and verification result.",
    }, undefined, undefined, harness.ctx);
    assert.equal(applied.isError, undefined);
    const recovered = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    const projectionId = recovered.metrics.growthProjectionId;
    assert.equal(recovered.blocks.length, 1);
    assert.equal(recovered.blocks[0].tier, 1);
    reportProviderUsage(harness, recovered.metrics.effectiveTransformedContextTokensEstimate);
    harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    const measuredRecovery = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    assert.equal(measuredRecovery.compression.emergency.projections[projectionId].lastOutcome, "recovered");
    assert.equal(measuredRecovery.metrics.effectiveTransformedContextTokensEstimate <=
      Math.floor(contextWindow * 0.7), true);
    assert.equal(
      recovered.compression.growth.projections[projectionId].baselineEffectiveTokens,
      recovered.metrics.effectiveTransformedContextTokensEstimate,
    );
    assert.ok(harness.notices.includes("big-pi recovered context pressure."));
    assert.doesNotMatch(harness.notices.join("\n"), /interrupted request|resubmit/i);
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx), undefined);
    assert.equal(readFileSync(harness.sessionPath, "utf8"), transcript);
    assert.equal(readState(sidecarPath(harness.sessionPath), harness.sessionPath).state.compression.growth.projections[projectionId].lastNudgeAt, null);
    assert.equal(before.compression.growth.projections[projectionId].lastNudgeAt, null);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pre-overflow pressure with no eligible source immediately hands the next compaction to Pi", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-pressure-no-range-"));
  const projection = fixtureProjection(8, { messageChars: 600 });
  const transcript = projection.entries.map((entry) => JSON.stringify(entry.sourceEntry)).join("\n") + "\n";
  const contextWindow = windowForUsage(projection, 96);
  const harness = extensionHarness(directory, () => projection, {
    emergency: { enabled: true },
    protectedRecentMessages: 100,
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow }),
  });
  try {
    writeFileSync(harness.sessionPath, transcript);
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx), undefined);
    const state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    const record = state.compression.emergency.projections[state.metrics.growthProjectionId];
    assert.equal(record.lastOutcome, "fallback-pending");
    assert.equal(record.nativeFallbackState, "pending");
    assert.match(record.lastReason, /no safe eligible range/);
    assert.equal(harness.handlers.get("session_before_compact")({ reason: "threshold" }, harness.ctx), undefined);
    assert.equal(readFileSync(harness.sessionPath, "utf8"), transcript);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("partial emergency recovery permits one progress-triggered attempt then yields at exhaustion", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-pressure-partial-"));
  const projection = fixtureProjection(12, { messageChars: 2400 });
  const transcript = projection.entries.map((entry) => JSON.stringify(entry.sourceEntry)).join("\n") + "\n";
  const contextWindow = windowForUsage(projection, 96);
  const harness = extensionHarness(directory, () => projection, {
    emergency: { enabled: true },
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow }),
  });
  try {
    writeFileSync(harness.sessionPath, transcript);
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    reportProviderUsage(harness, estimateTokens(projection.messages));
    const first = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    assert.match(first.systemPrompt, /attempt 1\/2/);
    const sources = await harness.tools.get("big_pi_compression_sources").execute("sources", {}, undefined, undefined, harness.ctx);
    const range = JSON.parse(sources.content[0].text).eligibleRanges[0];
    const effectiveBefore = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state.metrics.effectiveTransformedContextTokensEstimate;
    const partial = await harness.tools.get("big_pi_compress").execute("partial", {
      startRef: range.sources[0].ref,
      endRef: range.sources[0].ref,
      summary: `Keep the durable state ${"d".repeat(500)}.`,
    }, undefined, undefined, harness.ctx);
    assert.equal(partial.isError, undefined);
    const state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    assert.equal(state.metrics.effectiveTransformedContextTokensEstimate < effectiveBefore, true);
    assert.equal(state.metrics.effectiveTransformedContextTokensEstimate >
      Math.floor(contextWindow * 0.7), true);
    assert.equal(state.compression.emergency.projections[state.metrics.growthProjectionId].lastOutcome, "partial");

    reportProviderUsage(harness, Math.floor(contextWindow * 0.8));
    const second = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    assert.match(second.systemPrompt, /attempt 2\/2/);
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx), undefined);
    assert.equal(harness.handlers.get("session_before_compact")({
      reason: "overflow",
      willRetry: true,
    }, harness.ctx), undefined);
    const afterFallback = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    assert.equal(afterFallback.compression.emergency.projections[afterFallback.metrics.growthProjectionId].lastOutcome, "fallback-pending");
    await harness.commands.get("big-pi").handler("status", harness.ctx);
    assert.match(harness.notices.at(-1), /Compaction owner:\s+Pi/);
    assert.match(harness.notices.at(-1), /Recovery state:\s+Pi fallback pending; Pi owns compaction/);
    assert.match(harness.notices.at(-1), /attempts exhausted/);
    assert.equal(readFileSync(harness.sessionPath, "utf8"), transcript);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Pi overflow queues one emergency workflow and exhaustion yields native retry ownership", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-overflow-recovery-"));
  const projection = fixtureProjection(12, { messageChars: 1800 });
  const transcript = projection.entries.map((entry) => JSON.stringify(entry.sourceEntry)).join("\n") + "\n";
  const contextWindow = windowForUsage(projection, 107);
  const harness = extensionHarness(directory, () => projection, {
    emergency: { enabled: true },
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow }),
  });
  try {
    writeFileSync(harness.sessionPath, transcript);
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const compact = harness.handlers.get("session_before_compact");
    reportProviderUsage(harness, estimateTokens(projection.messages));
    const expectedReclaim = Math.max(
      0,
      estimateTokens(projection.messages) - Math.floor(contextWindow * 0.7),
    );
    assert.deepEqual(compact({ reason: "overflow", willRetry: true }, harness.ctx), { cancel: true });
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0].delivery.deliverAs, "followUp");
    assert.match(harness.sentMessages[0].message, /overflow recovery \(attempt 1\/2\)/);
    assert.match(harness.sentMessages[0].message, /"sourceType":"raw"/);
    assert.match(harness.sentMessages[0].message, /candidateId/);
    assert.match(harness.sentMessages[0].message, /big_pi_compression_sources/);
    assert.match(harness.sentMessages[0].message, /do not repeat identical arguments/);
    assert.match(harness.sentMessages[0].message, /resume the user's task automatically/i);
    assert.match(harness.sentMessages[0].message, /without asking the user to resubmit/i);
    assert.doesNotMatch(harness.sentMessages[0].message, /tell the user to resubmit/i);
    let state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    let record = state.compression.emergency.projections[state.metrics.growthProjectionId];
    assert.equal(record.lastOverflowReason, "Pi overflow");
    assert.equal(record.lastOutcome, "requested");
    assert.equal(record.lastEstimatedReclaimTokens, expectedReclaim);

    assert.deepEqual(compact({ reason: "overflow", willRetry: true }, harness.ctx), { cancel: true });
    assert.equal(harness.sentMessages.length, 1, "a second recovery request must wait for the queued turn to settle");
    harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    await harness.handlers.get("agent_end")({}, harness.ctx);
    assert.deepEqual(compact({ reason: "overflow", willRetry: true }, harness.ctx), { cancel: true });
    assert.equal(harness.sentMessages.length, 2);
    harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    await harness.handlers.get("agent_end")({}, harness.ctx);
    assert.equal(compact({ reason: "overflow", willRetry: true }, harness.ctx), undefined);
    state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    record = state.compression.emergency.projections[state.metrics.growthProjectionId];
    assert.equal(record.lastOutcome, "fallback-pending");
    await harness.commands.get("big-pi").handler("status", harness.ctx);
    const status = harness.notices.at(-1);
    assert.match(status, /Current pressure state:\s+OVERFLOW/);
    assert.match(status, /Context used:\s+107\.\d%/);
    assert.match(status, /Context remaining:\s+-7\.\d%/);
    assert.match(status, /Over\/under budget:\s+\d+ tokens over budget/);
    assert.match(status, /Compaction owner:\s+Pi/);
    assert.match(status, /Last emergency outcome:\s+fallback-pending/);
    assert.match(status, /attempts exhausted/);
    assert.equal(readFileSync(harness.sessionPath, "utf8"), transcript);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an authoritative overflow still requests recovery when no denominator is available", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-overflow-no-window-"));
  const projection = fixtureProjection(10, { messageChars: 600 });
  const harness = extensionHarness(directory, () => projection, {
    emergency: { enabled: true },
    getContextUsage: () => undefined,
  });
  try {
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    assert.deepEqual(harness.handlers.get("session_before_compact")({
      reason: "overflow",
      willRetry: true,
    }, harness.ctx), { cancel: true });
    assert.match(harness.sentMessages[0].message, /no reliable context-window denominator is available/);
    const sourceResult = await harness.tools.get("big_pi_compression_sources").execute("sources", {}, undefined, undefined, harness.ctx);
    const sourceIndex = JSON.parse(sourceResult.content[0].text);
    assert.equal(sourceIndex.emergency.usedPercentage, null);
    assert.equal(sourceIndex.emergency.remainingPercentage, null);
    assert.equal(sourceIndex.emergency.estimatedReclaimTokens, null);
    assert.equal(sourceIndex.emergency.pressureState, "OVERFLOW");
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("overflow with no safe range yields to Pi without violating protection or hierarchy scope", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-overflow-no-range-"));
  const projection = fixtureProjection(8, { messageChars: 500 });
  const transcript = projection.entries.map((entry) => JSON.stringify(entry.sourceEntry)).join("\n") + "\n";
  const contextWindow = windowForUsage(projection, 105);
  const harness = extensionHarness(directory, () => projection, {
    emergency: { enabled: true },
    protectedRecentMessages: 100,
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow }),
  });
  try {
    writeFileSync(harness.sessionPath, transcript);
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    assert.equal(harness.handlers.get("session_before_compact")({
      reason: "overflow",
      willRetry: true,
    }, harness.ctx), undefined);
    assert.equal(harness.sentMessages.length, 0);
    const state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    const record = state.compression.emergency.projections[state.metrics.growthProjectionId];
    assert.equal(record.lastOutcome, "fallback-pending");
    assert.match(record.lastReason, /no safe eligible range/);
    assert.equal(state.blocks.length, 0);
    assert.equal(readFileSync(harness.sessionPath, "utf8"), transcript);
    await harness.commands.get("big-pi").handler("status", harness.ctx);
    assert.match(harness.notices.at(-1), /Recovery reason:.*no safe eligible range/);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("overflow keeps existing Tier-1 blocks when no qualified hierarchy promotion is available", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-overflow-tier1-"));
  const projection = fixtureProjection(10, { messageChars: 500 });
  const transcript = projection.entries.map((entry) => JSON.stringify(entry.sourceEntry)).join("\n") + "\n";
  const contextWindow = windowForUsage(projection, 104);
  const harness = extensionHarness(directory, () => projection, {
    emergency: { enabled: true },
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow }),
  });
  try {
    writeFileSync(harness.sessionPath, transcript);
    const state = createEmptyState(harness.sessionPath);
    const bindings = ensureMessageReferences(state, projection);
    const protectedSet = computeProtectedRefs(bindings, {
      protectedRecentMessages: 1,
      protectedRecentTokens: 0,
    }).refs;
    const eligible = bindings.filter((binding) => !protectedSet.has(binding.ref));
    applyCompression(state, bindings, protectedSet, eligible[0].ref, eligible.at(-1).ref, "Preserve this earlier durable work.", 100);
    persistState(sidecarPath(harness.sessionPath), state);
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    assert.equal(harness.handlers.get("session_before_compact")({
      reason: "overflow",
      willRetry: true,
    }, harness.ctx), undefined);
    const persisted = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    const record = persisted.compression.emergency.projections[persisted.metrics.growthProjectionId];
    assert.equal(persisted.blocks.length, 1);
    assert.equal(persisted.blocks[0].tier, 1);
    assert.match(record.lastReason, /no safe uncovered range or qualified hierarchy promotion/);
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(readFileSync(harness.sessionPath, "utf8"), transcript);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("overflow may offer bounded Tier-2 promotion only after raw sources are exhausted", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-overflow-hierarchy-"));
  const projection = fixtureProjection(14, { messageChars: 900 });
  const transcript = projection.entries.map((entry) => JSON.stringify(entry.sourceEntry)).join("\n") + "\n";
  const harness = extensionHarness(directory, () => projection, {
    emergency: { enabled: true, maxAttemptsPerTurn: 1 },
    hierarchy: { enabled: true, minBlocksPerPromotion: 3 },
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow: 20000 }),
  });
  try {
    writeFileSync(harness.sessionPath, transcript);
    const state = createEmptyState(harness.sessionPath);
    const bindings = ensureMessageReferences(state, projection);
    const children = createTier1Blocks(state, projection, bindings, 4, 3);
    persistState(sidecarPath(harness.sessionPath), state);
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    reportProviderUsage(harness, estimateTokens(projection.messages));
    assert.equal(harness.handlers.get("session_before_compact")({
      reason: "overflow",
      willRetry: true,
    }, harness.ctx).cancel, true);
    assert.equal(harness.sentMessages.length, 1);
    assert.match(harness.sentMessages[0].message, /"sourceType":"blocks","tier":1/);
    assert.match(harness.sentMessages[0].message, /candidateId/);
    assert.match(harness.sentMessages[0].message, /evidence-aware summary/);
    assert.equal(readState(sidecarPath(harness.sessionPath), harness.sessionPath).state.blocks.length, 4);

    const listed = await harness.tools.get("big_pi_compression_sources")
      .execute("tier1", { sourceType: "blocks", tier: 1 }, undefined, undefined, harness.ctx);
    const candidate = JSON.parse(listed.content[0].text).candidates[0];
    assert.deepEqual(candidate.sourceBlockIds, children.map((block) => block.id));
    const promoted = await harness.tools.get("big_pi_compress").execute("emergency-promote", {
      sourceBlockIds: candidate.sourceBlockIds,
      summary: "Retain the durable decisions, implementation status, unresolved work, and verification results.",
    }, undefined, undefined, harness.ctx);
    assert.equal(promoted.isError, undefined);
    let persisted = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    reportProviderUsage(harness, persisted.metrics.effectiveTransformedContextTokensEstimate);
    harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    persisted = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    assert.equal(persisted.blocks.at(-1).tier, 2);
    assert.equal(persisted.compression.emergency.projections[persisted.metrics.growthProjectionId].lastOutcome, "recovered");
    assert.equal(readFileSync(harness.sessionPath, "utf8"), transcript);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pressure attempts are isolated by branch and restore without poisoning another branch", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-emergency-branches-"));
  const branchA = branchProjection("emergency-a", 900);
  const branchB = branchProjection("emergency-b", 900);
  const windows = new Map([
    [branchA, windowForUsage(branchA, 93)],
    [branchB, windowForUsage(branchB, 60)],
  ]);
  let currentProjection = branchA;
  const harness = extensionHarness(directory, () => currentProjection, {
    emergency: { enabled: true },
    getTree: () => sessionTree([branchA, branchB]),
    getContextUsage: () => ({
      tokens: estimateTokens(currentProjection.messages),
      contextWindow: windows.get(currentProjection),
    }),
  });
  try {
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const attemptA = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    assert.match(attemptA.systemPrompt, /big-pi emergency pressure \(attempt 1\/2\)/);

    currentProjection = branchB;
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx), undefined);
    currentProjection = branchA;
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx), undefined);
    await harness.commands.get("big-pi").handler("status", harness.ctx);
    assert.match(harness.notices.at(-1), /Current pressure state:\s+PRESSURE/);
    assert.match(harness.notices.at(-1), /Recovery state:\s+active \(1 \/ 2 attempts\)/);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart reloads emergency diagnostics but does not resume a stale cancellation loop", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-emergency-restart-"));
  const projection = fixtureProjection(12, { messageChars: 1200 });
  const transcript = projection.entries.map((entry) => JSON.stringify(entry.sourceEntry)).join("\n") + "\n";
  const contextWindow = windowForUsage(projection, 105);
  const options = {
    emergency: { enabled: true },
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow }),
  };
  const first = extensionHarness(directory, () => projection, options);
  try {
    writeFileSync(first.sessionPath, transcript);
    await first.handlers.get("session_start")({ reason: "startup" }, first.ctx);
    assert.deepEqual(first.handlers.get("session_before_compact")({
      reason: "overflow",
      willRetry: true,
    }, first.ctx), { cancel: true });
    assert.equal(first.sentMessages.length, 1);
    const requested = readState(sidecarPath(first.sessionPath), first.sessionPath).state;
    assert.equal(requested.compression.emergency.projections[requested.metrics.growthProjectionId].lastOutcome, "requested");

    const restarted = extensionHarness(directory, () => projection, options);
    try {
      await restarted.handlers.get("session_start")({ reason: "resume" }, restarted.ctx);
      assert.equal(restarted.sentMessages.length, 0);
      assert.equal(restarted.handlers.get("session_before_compact")({
        reason: "overflow",
        willRetry: true,
      }, restarted.ctx), undefined);
      await restarted.commands.get("big-pi").handler("status", restarted.ctx);
      const status = restarted.notices.at(-1);
      assert.match(status, /Compaction owner:\s+Pi/);
      assert.match(status, /Last emergency outcome:\s+interrupted/);
      assert.match(status, /automatic retry suppressed/);
      assert.equal(readFileSync(restarted.sessionPath, "utf8"), transcript);
    } finally {
      restoreHarnessConfig(restarted);
    }
  } finally {
    restoreHarnessConfig(first);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid manifests fail open to Pi compaction with actionable status", async () => {
  const cases = [
    {
      name: "malformed manifest",
      prepare(manifest) { mkdirSync(path.dirname(manifest), { recursive: true }); writeFileSync(manifest, "{"); },
      reason: /Malformed big-pi manifest JSON/,
    },
    {
      name: "unsupported schema",
      prepare(manifest) { mkdirSync(path.dirname(manifest), { recursive: true }); writeFileSync(manifest, JSON.stringify({ schemaVersion: 99 })); },
      reason: /Unsupported or invalid big-pi manifest/,
    },
    {
      name: "invalid committed chunk path",
      prepare(manifest, sessionPath) {
        mkdirSync(path.dirname(manifest), { recursive: true });
        writeFileSync(manifest, JSON.stringify({
          schemaVersion: 1,
          producer: "big-pi",
          session: { sessionPath },
          recovery: { damagedBlocks: [] },
          blocks: [{
            blockId: "B000001",
            tier: 1,
            chunkPath: "../outside.json",
            sha256: "a".repeat(64),
          }],
        }));
      },
      reason: /invalid or duplicate committed chunk index entry/,
    },
  ];

  for (const item of cases) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-degraded-compact-"));
    const projection = fixtureProjection(6, { messageChars: 120 });
    const harness = extensionHarness(directory, () => projection);
    try {
      item.prepare(sidecarPath(harness.sessionPath), harness.sessionPath);
      await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
      assert.equal(
        harness.handlers.get("session_before_compact")({ reason: "threshold", willRetry: false }, harness.ctx),
        undefined,
        item.name,
      );
      await harness.commands.get("big-pi").handler("status", harness.ctx);
      const status = harness.notices.at(-1);
      assert.match(status, /State:\s+degraded/);
      assert.match(status, /Compaction owner:\s+Pi/);
      assert.match(status, /Pi native compaction:\s+allowed/);
      assert.match(status, item.reason);
      assert.match(status, /Native compact attempts:\s+1/);
      assert.match(status, /Native compactions cancelled:\s+0/);
    } finally {
      restoreHarnessConfig(harness);
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("a transient request projection mismatch does not relinquish native compaction ownership", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-transient-compact-"));
  const projection = fixtureProjection(6, { messageChars: 240 });
  const harness = extensionHarness(directory, () => projection);
  try {
    await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
    const mismatched = [...projection.messages];
    [mismatched[1], mismatched[2]] = [mismatched[2], mismatched[1]];
    const failedOpen = harness.handlers.get("context")({ messages: mismatched }, harness.ctx);
    assert.strictEqual(failedOpen.messages, mismatched);

    assert.deepEqual(
      harness.handlers.get("session_before_compact")({ reason: "threshold", willRetry: false }, harness.ctx),
      { cancel: true },
    );
    await harness.commands.get("big-pi").handler("status", harness.ctx);
    assert.match(harness.notices.at(-1), /State:\s+active/);
    assert.match(harness.notices.at(-1), /Compaction owner:\s+big-pi/);
    assert.match(harness.notices.at(-1), /Native compactions cancelled:\s+1/);
    assert.equal(harness.notices.some((notice) => notice.includes("failed open")), true);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native compaction ownership survives restart, branch changes, and historical Pi compaction entries", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-compact-reload-"));
  const rootProjection = fixtureProjection(6, { messageChars: 160 });
  const otherProjection = branchProjection("other-branch", 160);
  let currentProjection = rootProjection;
  let activeSessionPath;
  const getBranch = () => [{
    type: "compaction",
    id: "historical-pi-compaction",
    summary: "A prior Pi summary remains authoritative history.",
  }];
  const options = { getBranch, getSessionPath: () => activeSessionPath };
  const first = extensionHarness(directory, () => currentProjection, options);
  activeSessionPath = first.sessionPath;
  try {
    await first.handlers.get("session_start")({ reason: "startup" }, first.ctx);
    assert.deepEqual(
      first.handlers.get("session_before_compact")({ reason: "threshold", willRetry: false }, first.ctx),
      { cancel: true },
    );
    const savedState = readState(sidecarPath(first.sessionPath), first.sessionPath).state;
    assert.equal(savedState.schemaVersion, 1);
    assert.equal(first.handlerRegistrations.get("session_before_compact").length, 1);

    const restarted = extensionHarness(directory, () => currentProjection, options);
    try {
      await restarted.handlers.get("session_start")({ reason: "resume" }, restarted.ctx);
      assert.equal(restarted.handlerRegistrations.get("session_before_compact").length, 1);
      assert.deepEqual(
        restarted.handlers.get("session_before_compact")({ reason: "manual", willRetry: false }, restarted.ctx),
        { cancel: true },
      );

      currentProjection = otherProjection;
      assert.deepEqual(
        restarted.handlers.get("session_before_compact")({ reason: "threshold", willRetry: false }, restarted.ctx),
        { cancel: true },
      );
      await restarted.commands.get("big-pi").handler("status", restarted.ctx);
      const status = restarted.notices.at(-1);
      assert.match(status, /Compaction owner:\s+big-pi/);
      assert.match(status, /Native compact attempts:\s+2/);
      assert.match(status, /Historical Pi compaction:\s+present \(left intact; not created by big-pi\)/);
      assert.equal(getBranch()[0].id, "historical-pi-compaction");
      assert.equal(restarted.handlerRegistrations.get("session_before_compact").length, 1);
      assert.equal(readState(sidecarPath(restarted.sessionPath), restarted.sessionPath).state.schemaVersion, 1);

      activeSessionPath = path.join(directory, "switched-session.jsonl");
      currentProjection = fixtureProjection(5, { prefix: "switched-session", messageChars: 180 });
      await restarted.handlers.get("session_start")({ reason: "resume" }, restarted.ctx);
      assert.deepEqual(
        restarted.handlers.get("session_before_compact")({ reason: "threshold", willRetry: false }, restarted.ctx),
        { cancel: true },
      );
      await restarted.commands.get("big-pi").handler("status", restarted.ctx);
      assert.match(restarted.notices.at(-1), /Compaction owner:\s+big-pi/);
      assert.match(restarted.notices.at(-1), /Native compact attempts:\s+1/);
      assert.equal(restarted.handlerRegistrations.get("session_before_compact").length, 1);
    } finally {
      restoreHarnessConfig(restarted);
    }
  } finally {
    restoreHarnessConfig(first);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a minimum-sized candidate is exposed while a smaller isolated range is not offered", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-candidates-"));
  const sessionPath = path.join(directory, "session.jsonl");
  const entries = [];
  const rolesAndLengths = [
    ["user", 10],
    ["assistant", 10],
    ["system", 10],
    ["assistant", 40],
    ["toolResult", 40],
    ["user", 10],
  ];
  for (const [index, [role, length]] of rolesAndLengths.entries()) {
    const message = textMessage(role, "x".repeat(length));
    entries.push({
      sourceEntry: { id: `candidate-${index}`, parentId: entries.at(-1)?.sourceEntry.id ?? null, type: "message" },
      messages: [message],
    });
  }
  const projection = { entries, messages: entries.flatMap((entry) => entry.messages) };
  const configPath = path.join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({
    minCompressRangeChars: 60,
    protectedRecentMessages: 1,
    protectedRecentTokens: 0,
  }));
  const prior = process.env.BIG_PI_CONFIG;
  process.env.BIG_PI_CONFIG = configPath;
  let sourceTool;
  try {
    bigPi({
      registerTool(tool) { if (tool.name === "big_pi_compression_sources") sourceTool = tool; },
      registerCommand() {},
      on() {},
    });
    const ctx = {
      sessionManager: { getSessionFile: () => sessionPath, buildSessionProjection: () => projection },
    };
    const result = await sourceTool.execute("call", {}, undefined, undefined, ctx);
    const candidates = JSON.parse(result.content[0].text).eligibleRanges;
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].sourceChars >= 60, true);
    assert.deepEqual(candidates[0].sources.map((source) => source.ref), ["M000003", "M000004"]);
  } finally {
    if (prior === undefined) delete process.env.BIG_PI_CONFIG;
    else process.env.BIG_PI_CONFIG = prior;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("growth nudges track effective-context growth, suppress declined intervals, and survive restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-growth-cadence-"));
  const sessionPath = path.join(directory, "session.jsonl");
  const projection = fixtureProjection(3, { messageChars: 30 });
  const first = extensionHarness(directory, () => projection, {
    growthTriggerTokens: 1000,
    nudge: { mode: "growth" },
  });
  const restoreConfig = first.previousConfig;
  try {
    await first.handlers.get("session_start")({}, first.ctx);
    const initialState = readState(sidecarPath(sessionPath), sessionPath).state;
    const projectionId = initialState.metrics.growthProjectionId;
    const baseline = initialState.metrics.effectiveTransformedContextTokensEstimate;
    assert.equal(initialState.compression.growth.projections[projectionId].baselineEffectiveTokens, baseline);

    setProjectionGrowth(projection, baseline, 999);
    assert.equal(first.handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, first.ctx), undefined);
    assert.equal(readState(sidecarPath(sessionPath), sessionPath).state.metrics.nudgeDue, false);

    setProjectionGrowth(projection, baseline, 1000);
    const advised = first.handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, first.ctx);
    assert.match(advised.systemPrompt, /big-pi advisory:/);
    assert.match(advised.systemPrompt, /semantic range/);
    assert.equal(first.sentMessages.length, 0);
    assert.equal(readState(sidecarPath(sessionPath), sessionPath).state.blocks.length, 0);
    assert.equal(first.handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, first.ctx), undefined);

    const restarted = extensionHarness(directory, () => projection, {
      growthTriggerTokens: 1000,
      nudge: { mode: "growth" },
    });
    await restarted.handlers.get("session_start")({}, restarted.ctx);
    reportProviderUsage(restarted, baseline + 1000);
    assert.equal(restarted.handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, restarted.ctx), undefined);
    await restarted.commands.get("big-pi").handler("status", restarted.ctx);
    const status = restarted.notices.at(-1);
    assert.match(status, /Growth trigger:\s+1,000 tokens/);
    assert.match(status, /Provider-measured growth since baseline:/);
    assert.match(status, /Next nudge at:/);
    assert.match(status, /Last nudge:/);
    assert.match(status, /Nudge due: no/);

    setProjectionGrowth(projection, baseline, 1999);
    assert.equal(restarted.handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, restarted.ctx), undefined);
    setProjectionGrowth(projection, baseline, 2000);
    const nextInterval = restarted.handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, restarted.ctx);
    assert.match(nextInterval.systemPrompt, /big-pi advisory:/);
    assert.equal(readState(sidecarPath(sessionPath), sessionPath).state.blocks.length, 0);
  } finally {
    restoreHarnessConfig({ previousConfig: restoreConfig });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("successful compression advances the effective baseline and later growth can nudge again", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-growth-compression-"));
  const sessionPath = path.join(directory, "session.jsonl");
  const projection = fixtureProjection(8, { messageChars: 12000 });
  const harness = extensionHarness(directory, () => projection, {
    growthTriggerTokens: 500,
    minCompressRangeChars: 100,
  });
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    const baseline = readState(sidecarPath(sessionPath), sessionPath).state.metrics.effectiveTransformedContextTokensEstimate;
    setProjectionGrowth(projection, baseline, 500, "nudge-growth");
    const advisory = harness.handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, harness.ctx);
    assert.match(advisory.systemPrompt, /big-pi advisory:/);

    const sources = await harness.tools.get("big_pi_compression_sources")
      .execute("sources", {}, undefined, undefined, harness.ctx);
    const eligible = JSON.parse(sources.content[0].text).eligibleRanges[0].sources;
    const applied = await harness.tools.get("big_pi_compress").execute("compress", {
      startRef: eligible[0].ref,
      endRef: eligible[1].ref,
      summary: "Retain the completed phase decision and its verification.",
    }, undefined, undefined, harness.ctx);
    assert.equal(applied.isError, undefined);
    const afterCompression = readState(sidecarPath(sessionPath), sessionPath).state;
    assert.equal(afterCompression.blocks.length, 1);
    assert.equal(
      afterCompression.compression.growth.projections[afterCompression.metrics.growthProjectionId].baselineEffectiveTokens,
      afterCompression.metrics.effectiveTransformedContextTokensEstimate,
    );
    assert.equal(afterCompression.metrics.growthSinceBaselineTokens, 0);
    assert.equal(afterCompression.metrics.nudgeDue, false);
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, harness.ctx), undefined);

    const compressionBaseline = afterCompression.metrics.effectiveTransformedContextTokensEstimate;
    setProjectionGrowth(projection, compressionBaseline, 500, "post-compression-growth", afterCompression);
    const nextAdvisory = harness.handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, harness.ctx);
    assert.match(nextAdvisory.systemPrompt, /big-pi advisory:/);
    const finalState = readState(sidecarPath(sessionPath), sessionPath).state;
    assert.equal(finalState.blocks.length, 1);
    assert.equal(finalState.compression.growth.projections[finalState.metrics.growthProjectionId].lastSuccessfulCompressionAt, finalState.blocks[0].createdAt);
    assert.equal(JSON.stringify(projection.entries.map((entry) => entry.sourceEntry)).includes("big-pi compressed context"), false);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("branch-specific growth cadence survives navigation and remains independent", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-growth-branches-"));
  const branchA = branchProjection("A", 260);
  const branchB = branchProjection("B", 40);
  const tree = sessionTree([branchA, branchB]);
  let currentProjection = branchA;
  const harness = extensionHarness(directory, () => currentProjection, {
    growthTriggerTokens: 500,
    nudge: { mode: "growth" },
    getTree: () => tree,
  });
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    const initialA = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    const baselineA = initialA.metrics.effectiveTransformedContextTokensEstimate;
    setProjectionGrowth(branchA, baselineA, 500, "A-growth");
    assert.match(harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx).systemPrompt, /big-pi advisory:/);
    const branchAId = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state.metrics.growthProjectionId;

    currentProjection = branchB;
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx), undefined);
    const branchBState = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    const branchBId = branchBState.metrics.growthProjectionId;
    assert.notEqual(branchBId, branchAId);
    const baselineB = branchBState.metrics.effectiveTransformedContextTokensEstimate;
    setProjectionGrowth(branchB, baselineB, 500, "B-growth");
    assert.match(harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx).systemPrompt, /big-pi advisory:/);

    currentProjection = branchA;
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx), undefined);
    const finalState = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    assert.equal(Object.keys(finalState.compression.growth.projections).length, 2);
    assert.equal(finalState.metrics.growthProjectionId, branchAId);
    assert.equal(finalState.metrics.nudgeDue, false);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("percentage nudges use configured display, persist checkpoints, and report status", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-percentage-"));
  const sessionPath = path.join(directory, "session.jsonl");
  const projection = fixtureProjection(3, { messageChars: 30 });
  const options = {
    growthTriggerTokens: 100000,
    nudge: {
      mode: "percentage",
      growthTriggerTokens: 100000,
      thresholdPercentage: 70,
      repeatEveryPercentage: 10,
      display: "used",
    },
    getContextUsage: () => ({ tokens: null, contextWindow: 1000, percent: null }),
  };
  const harness = extensionHarness(directory, () => projection, options);
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    const state = readState(sidecarPath(sessionPath), sessionPath).state;
    const projectionId = state.metrics.growthProjectionId;
    const effectiveAt = (percent) => Math.round(1000 * percent / 100);

    setProjectionEffectiveTokens(projection, effectiveAt(69));
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx), undefined);
    setProjectionEffectiveTokens(projection, effectiveAt(70));
    const first = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    assert.match(first.systemPrompt, /70\.0% used/);
    assert.match(first.systemPrompt, /percentage checkpoint 70%/);
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx), undefined);
    setProjectionEffectiveTokens(projection, effectiveAt(71));
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx), undefined);
    setProjectionEffectiveTokens(projection, effectiveAt(80));
    assert.match(
      harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx).systemPrompt,
      /percentage checkpoint 80%/,
    );

    const persisted = readState(sidecarPath(sessionPath), sessionPath).state;
    const cadence = persisted.compression.percentage.projections[projectionId];
    assert.equal(cadence.lastDeliveredCheckpointPercentage, 80);
    assert.equal(cadence.nextCheckpointPercentage, 90);
    assert.equal(typeof cadence.lastNudgeAt, "string");
    assert.equal(persisted.metrics.currentUsedPercentage, 80);
    assert.equal(persisted.metrics.currentRemainingPercentage, 20);

    const restarted = extensionHarness(directory, () => projection, options);
    await restarted.handlers.get("session_start")({}, restarted.ctx);
    reportProviderUsage(restarted, 800);
    assert.equal(restarted.handlers.get("before_agent_start")({ systemPrompt: "" }, restarted.ctx), undefined);
    await restarted.commands.get("big-pi").handler("status", restarted.ctx);
    const status = restarted.notices.at(-1);
    assert.match(status, /Nudge mode:\s+percentage/);
    assert.match(status, /Percentage threshold:\s+70%/);
    assert.match(status, /Percentage repeat interval:\s+10%/);
    assert.match(status, /Percentage display:\s+used/);
    assert.match(status, /Usable context window:\s+1,000 tokens/);
    assert.match(status, /Context used:\s+80\.0%/);
    assert.match(status, /Context remaining:\s+20\.0%/);
    assert.match(status, /Last percentage checkpoint:\s+80%/);
    assert.match(status, /Next percentage checkpoint:\s+90%/);
    assert.match(status, /Last percentage nudge:\s+\d{4}-/);
    assert.match(status, /Percentage nudge due:\s+no/);
    assert.match(status, /Growth nudge due:\s+no/);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("context thresholds use provider usage; nudge is advisory and emergency alone starts compression", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-provider-thresholds-"));
  const projection = fixtureProjection(12, { messageChars: 1800 });
  const harness = extensionHarness(directory, () => projection, {
    nudge: { mode: "percentage", thresholdPercentage: 70, repeatEveryPercentage: 10, display: "used" },
    emergency: { enabled: true, pressureThresholdPercentage: 90, targetPercentageAfterCompression: 70 },
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow: 1000 }),
  });
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    // Deliberately large local projection estimates must not trigger a nudge.
    reportProviderUsage(harness, 600);
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx), undefined);

    reportProviderUsage(harness, 700);
    const nudge = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    assert.match(nudge.systemPrompt, /percentage checkpoint 70%/);
    assert.equal(harness.handlers.get("context")({ messages: projection.messages }, harness.ctx).messages.length,
      projection.messages.length);
    assert.equal(harness.handlers.get("tool_call")({ toolName: "bash" }, harness.ctx), undefined);

    reportProviderUsage(harness, 900);
    const emergency = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    assert.match(emergency.systemPrompt, /big-pi emergency pressure/);
    assert.match(emergency.systemPrompt, /next response must be a tool call/i);
    assert.match(emergency.systemPrompt, /"candidateId":"<exact returned id>"/);
    assert.match(emergency.systemPrompt, /"summary":"<your evidence-aware summary>"/);
    assert.doesNotMatch(emergency.systemPrompt, /percentage checkpoint 90%/,
      "the emergency threshold takes precedence over a same-level ordinary nudge");
    const context = harness.handlers.get("context")({ messages: projection.messages }, harness.ctx);
    assert.match(context.messages.at(-1).content[0].text, /BIG-PI EMERGENCY COMPRESSION/);
    assert.equal(harness.handlers.get("tool_call")({ toolName: "bash" }, harness.ctx).block, true);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("post-turn provider output tokens count toward actual context thresholds", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-provider-output-"));
  const projection = fixtureProjection(8, { messageChars: 12000 });
  const harness = extensionHarness(directory, () => projection, {
    growthTriggerTokens: 100000,
    nudge: { mode: "percentage", thresholdPercentage: 70, repeatEveryPercentage: 10, display: "used" },
    getContextUsage: () => ({ tokens: null, contextWindow: 1000, percent: null }),
  });
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    harness.setProviderUsageExplicit();
    harness.handlers.get("turn_end")({ message: {
      role: "assistant",
      usage: { input: 600, cacheRead: 100, cacheWrite: 50, output: 100 },
    } }, harness.ctx);
    const guidance = harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx);
    assert.match(guidance.systemPrompt, /percentage checkpoint 70%/);
    const state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    assert.equal(state.metrics.piContextUsageTokens, 850);
    assert.equal(state.metrics.currentUsedPercentage, 85);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("percentage display and status preserve negative remaining and over-budget metrics", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-over-budget-"));
  const sessionPath = path.join(directory, "session.jsonl");
  const projection = fixtureProjection(3, { messageChars: 30 });
  const harness = extensionHarness(directory, () => projection, {
    growthTriggerTokens: 1000000,
    nudge: {
      mode: "percentage",
      growthTriggerTokens: 1000000,
      thresholdPercentage: 70,
      repeatEveryPercentage: 10,
      display: "remaining",
    },
    getContextUsage: () => ({ tokens: null, contextWindow: 200000, percent: null }),
  });
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    setProjectionEffectiveTokens(projection, 140000);
    const positiveRemaining = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    assert.match(positiveRemaining.systemPrompt, /30\.0% of the nominal context remains/);
    setProjectionEffectiveTokens(projection, 214000);
    const advisory = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    assert.match(advisory.systemPrompt, /-7\.0%/);
    assert.match(advisory.systemPrompt, /14,000 tokens over budget/);
    const state = readState(sidecarPath(sessionPath), sessionPath).state;
    assert.equal(state.metrics.currentUsedPercentage, 107);
    assert.equal(state.metrics.currentRemainingPercentage, -7);
    assert.equal(state.metrics.contextBudgetDeltaTokens, -14000);
    assert.equal(state.compression.percentage.projections[state.metrics.growthProjectionId].lastDeliveredCheckpointPercentage, 80);
    await harness.commands.get("big-pi").handler("status", harness.ctx);
    const status = harness.notices.at(-1);
    assert.match(status, /Context used:\s+107\.0%/);
    assert.match(status, /Context remaining:\s+-7\.0%/);
    assert.match(status, /Over\/under budget:\s+14,000 tokens over budget/);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("percentage mode without a context window is unavailable while growth and hybrid still work", async () => {
  for (const mode of ["percentage", "growth", "hybrid"]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), `big-pi-no-window-${mode}-`));
    const projection = fixtureProjection(3, { messageChars: 30 });
    const nudge = {
      mode,
      growthTriggerTokens: 500,
      thresholdPercentage: 70,
      repeatEveryPercentage: 10,
      display: "used",
    };
    const harness = extensionHarness(directory, () => projection, {
      growthTriggerTokens: 500,
      nudge,
      getContextUsage: () => undefined,
    });
    try {
      await harness.handlers.get("session_start")({}, harness.ctx);
      const initial = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
      setProjectionGrowth(
        projection,
        initial.metrics.growthBaselineEffectiveTokens,
        500,
        `no-window-${mode}`,
      );
      const result = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
      if (mode === "percentage") {
        assert.equal(result, undefined);
        const metrics = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state.metrics;
        assert.equal(metrics.percentageStatus, "unavailable");
        assert.match(metrics.percentageUnavailableReason, /contextWindow/);
        await harness.commands.get("big-pi").handler("status", harness.ctx);
        assert.match(harness.notices.at(-1), /Percentage status:\s+unavailable/);
        assert.match(harness.notices.at(-1), /Reason: Pi did not expose/);
      } else {
        assert.match(result.systemPrompt, /big-pi advisory:/);
        const cadence = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state
          .compression.growth.projections[initial.metrics.growthProjectionId];
        assert.equal(cadence.cadenceNudgeGrowthTokens, 500);
      }
    } finally {
      restoreHarnessConfig(harness);
      rmSync(directory, { recursive: true, force: true });
    }
  }

  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-model-window-fallback-"));
  const fallbackHarness = extensionHarness(directory, () => fixtureProjection(3), {
    nudge: {
      mode: "percentage",
      growthTriggerTokens: 1000,
      thresholdPercentage: 70,
      repeatEveryPercentage: 10,
      display: "used",
    },
    getContextUsage: () => undefined,
    model: { contextWindow: 1000 },
  });
  try {
    await fallbackHarness.handlers.get("session_start")({}, fallbackHarness.ctx);
    assert.equal(readState(sidecarPath(fallbackHarness.sessionPath), fallbackHarness.sessionPath)
      .state.metrics.percentageStatus, "unavailable");
    reportProviderUsage(fallbackHarness, estimateTokens(fixtureProjection(3).messages));
    fallbackHarness.handlers.get("before_agent_start")({ systemPrompt: "" }, fallbackHarness.ctx);
    const state = readState(
      sidecarPath(fallbackHarness.sessionPath),
      fallbackHarness.sessionPath,
    ).state;
    assert.equal(state.metrics.percentageStatus, "available");
    assert.equal(state.metrics.usableContextWindow, 1000);
  } finally {
    restoreHarnessConfig(fallbackHarness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hybrid arbitration delivers once and advances only the due cadence", async () => {
  const cases = [
    { name: "neither", growthTriggerTokens: 100000, window: 1000, target: null, expectGrowth: false, expectPercentage: false },
    { name: "growth-only", growthTriggerTokens: 500, window: 100000, growth: 500, expectGrowth: true, expectPercentage: false },
    { name: "percentage-only", growthTriggerTokens: 100000, window: 1000, target: 1000, expectGrowth: false, expectPercentage: true },
    { name: "both", growthTriggerTokens: 1, window: 1000, target: 1000, expectGrowth: true, expectPercentage: true },
  ];
  for (const item of cases) {
    const directory = mkdtempSync(path.join(os.tmpdir(), `big-pi-hybrid-${item.name}-`));
    const projection = fixtureProjection(3, { messageChars: 30 });
    const nudge = {
      mode: "hybrid",
      growthTriggerTokens: item.growthTriggerTokens,
      thresholdPercentage: 70,
      repeatEveryPercentage: 10,
      display: "remaining",
    };
    const harness = extensionHarness(directory, () => projection, {
      growthTriggerTokens: item.growthTriggerTokens,
      nudge,
      getContextUsage: () => ({ tokens: null, contextWindow: item.window, percent: null }),
    });
    try {
      await harness.handlers.get("session_start")({}, harness.ctx);
      const initial = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
      if (Number.isSafeInteger(item.target)) {
        setProjectionEffectiveTokens(projection, item.target);
      } else if (item.growth !== undefined) {
        setProjectionGrowth(
          projection,
          initial.metrics.growthBaselineEffectiveTokens,
          item.growth,
          `hybrid-${item.name}`,
        );
      }
      const result = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
      assert.equal(Boolean(result), item.expectGrowth || item.expectPercentage, item.name);
      if (!result) continue;
      assert.match(result.systemPrompt, /big-pi advisory:/);
      const subsequent = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
      if (item.expectPercentage) {
        assert.match(subsequent.systemPrompt, /percentage checkpoint 80%/);
      } else {
        assert.equal(subsequent, undefined);
      }
      const persisted = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
      const projectionId = initial.metrics.growthProjectionId;
      const growthCadence = persisted.compression.growth.projections[projectionId];
      const percentageCadence = persisted.compression.percentage.projections[projectionId];
      assert.equal(growthCadence.cadenceNudgeGrowthTokens !== null, item.expectGrowth, item.name);
      assert.equal(
        percentageCadence.lastDeliveredCheckpointPercentage !== null,
        item.expectPercentage,
        item.name,
      );
    } finally {
      restoreHarnessConfig(harness);
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("percentage cadence is isolated by branch and restored when navigating", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-percentage-branches-"));
  const branchA = branchProjection("A", 40);
  const branchB = branchProjection("B", 40);
  const tree = sessionTree([branchA, branchB]);
  let activeProjection = branchA;
  const harness = extensionHarness(directory, () => activeProjection, {
    growthTriggerTokens: 1000000,
    getTree: () => tree,
    getContextUsage: () => ({ tokens: null, contextWindow: 10000, percent: null }),
    nudge: {
      mode: "percentage",
      growthTriggerTokens: 1000000,
      thresholdPercentage: 70,
      repeatEveryPercentage: 10,
      display: "used",
    },
  });
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    setProjectionEffectiveTokens(branchA, 8000, "branch-A-percentage");
    const firstA = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    assert.match(firstA.systemPrompt, /percentage checkpoint 70%/);
    const branchAId = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state.metrics.growthProjectionId;

    activeProjection = branchB;
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx), undefined);
    const branchBInitial = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    const branchBId = branchBInitial.metrics.growthProjectionId;
    assert.notEqual(branchBId, branchAId);
    setProjectionEffectiveTokens(branchB, 7000, "branch-B-percentage");
    const firstB = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    assert.match(firstB.systemPrompt, /percentage checkpoint 70%/);

    activeProjection = branchA;
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx), undefined);
    const finalState = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    assert.equal(finalState.compression.percentage.projections[branchAId].lastDeliveredCheckpointPercentage, 70);
    assert.equal(finalState.compression.percentage.projections[branchBId].lastDeliveredCheckpointPercentage, 70);
    assert.equal(Object.keys(finalState.compression.percentage.projections).length, 2);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("successful compression re-arms percentage checkpoints for a later ascent", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-percentage-compression-"));
  const sessionPath = path.join(directory, "session.jsonl");
  const projection = fixtureProjection(8, { messageChars: 12000 });
  let contextWindow = 1;
  const harness = extensionHarness(directory, () => projection, {
    growthTriggerTokens: 1000000,
    minCompressRangeChars: 100,
    nudge: {
      mode: "percentage",
      growthTriggerTokens: 1000000,
      thresholdPercentage: 70,
      repeatEveryPercentage: 10,
      display: "remaining",
    },
    getContextUsage: () => ({ tokens: null, contextWindow, percent: null }),
  });
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    const baseline = readState(sidecarPath(sessionPath), sessionPath).state.metrics.effectiveTransformedContextTokensEstimate;
    contextWindow = Math.floor(baseline * 100 / 90);
    reportProviderUsage(harness, baseline);
    const initialNudge = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    assert.match(initialNudge.systemPrompt, /percentage checkpoint 70%/);
    const initialState = readState(sidecarPath(sessionPath), sessionPath).state;
    const projectionId = initialState.metrics.growthProjectionId;
    assert.equal(
      initialState.compression.percentage.projections[projectionId].lastDeliveredCheckpointPercentage,
      70,
    );

    const sources = await harness.tools.get("big_pi_compression_sources")
      .execute("sources", {}, undefined, undefined, harness.ctx);
    const range = JSON.parse(sources.content[0].text).eligibleRanges[0].sources;
    const compressed = await harness.tools.get("big_pi_compress").execute("compress", {
      startRef: range[0].ref,
      endRef: range[3].ref,
      summary: "Keep the completed phase result and key decision.",
    }, undefined, undefined, harness.ctx);
    assert.equal(compressed.isError, undefined);
    const afterCompressionEstimate = readState(sidecarPath(sessionPath), sessionPath).state
      .metrics.effectiveTransformedContextTokensEstimate;
    reportProviderUsage(harness, afterCompressionEstimate);
    harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    const afterCompression = readState(sidecarPath(sessionPath), sessionPath).state;
    const cadence = afterCompression.compression.percentage.projections[projectionId];
    assert.equal(afterCompression.metrics.currentUsedPercentage < 89, true);
    assert.equal(cadence.rearmedAfterDrop, true);
    assert.equal(cadence.nextCheckpointPercentage, 70);

    const postCompressionTokens = afterCompression.metrics.effectiveTransformedContextTokensEstimate;
    const targetAt70 = Math.ceil(contextWindow * 0.7);
    reportProviderUsage(harness, targetAt70);
    const rearmed = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    assert.match(rearmed.systemPrompt, /percentage checkpoint 70%/);
    reportProviderUsage(harness, Math.ceil(contextWindow * 0.8));
    const next = harness.handlers.get("before_agent_start")({ systemPrompt: "" }, harness.ctx);
    assert.match(next.systemPrompt, /percentage checkpoint 80%/);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});


test("an emergency phase that ends without a block yields native compaction", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-pressure-no-commit-"));
  const projection = fixtureProjection(12, { messageChars: 1800 });
  const contextWindow = windowForUsage(projection, 96);
  const harness = extensionHarness(directory, () => projection, {
    emergency: { enabled: true },
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow }),
  });
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    assert.match(harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx).systemPrompt, /emergency pressure/);
    harness.handlers.get("context")({ messages: projection.messages }, harness.ctx);
    await harness.handlers.get("agent_end")({}, harness.ctx);

    let state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    let record = state.compression.emergency.projections[state.metrics.growthProjectionId];
    assert.equal(record.nativeFallbackState, "none",
      "one missing tool call gets a bounded follow-up before Pi takes ownership");
    assert.equal(harness.sentMessages.length, 1);

    assert.match(harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx).systemPrompt, /emergency pressure/);
    harness.handlers.get("context")({ messages: projection.messages }, harness.ctx);
    await harness.handlers.get("agent_end")({}, harness.ctx);

    state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    record = state.compression.emergency.projections[state.metrics.growthProjectionId];
    assert.equal(record.nativeFallbackState, "pending");
    assert.match(record.lastReason, /without committing a block/);
    assert.equal(harness.handlers.get("session_before_compact")({ reason: "threshold" }, harness.ctx), undefined);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ignored pressure guidance yields threshold compaction before repeated cancellations", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-threshold-progress-"));
  const projection = fixtureProjection(12, { messageChars: 1800 });
  const contextWindow = windowForUsage(projection, 96);
  const harness = extensionHarness(directory, () => projection, {
    emergency: { enabled: true },
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow }),
  });
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    assert.match(harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx).systemPrompt, /emergency pressure/);
    const compact = harness.handlers.get("session_before_compact");
    assert.equal(compact({ reason: "threshold" }, harness.ctx), undefined);
    assert.equal(compact({ reason: "threshold" }, harness.ctx), undefined);
    assert.equal(harness.sentMessages.length, 0);
    let state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    assert.equal(state.compression.emergency.projections[state.metrics.growthProjectionId].nativeFallbackState, "pending");
    harness.handlers.get("session_compact")({ reason: "threshold" }, harness.ctx);
    state = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    assert.equal(state.compression.emergency.projections[state.metrics.growthProjectionId].nativeFallbackState, "completed");
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("long prompt growth nudge leaves compression optional and task tools available", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-mid-prompt-"));
  const projection = fixtureProjection(8, { messageChars: 12000 });
  const harness = extensionHarness(directory, () => projection, {
    growthTriggerTokens: 500,
    nudge: { mode: "growth" },
  });
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    assert.equal(harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx), undefined);
    const baseline = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state.metrics.effectiveTransformedContextTokensEstimate;
    setProjectionGrowth(projection, baseline, 500, "mid-prompt-growth");
    const context = () => harness.handlers.get("context")({ messages: projection.messages }, harness.ctx);
    const first = context();
    assert.match(first.messages.at(-1).content[0].text, /big-pi advisory:/);
    assert.match(first.messages.at(-1).content[0].text, /model may choose whether to compress/i);
    const gate = harness.handlers.get("tool_call");
    assert.equal(gate({ toolName: "bash" }, harness.ctx), undefined);
    assert.equal(gate({ toolName: "write" }, harness.ctx), undefined);
    assert.equal(gate({ toolName: "edit" }, harness.ctx), undefined);
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(readState(sidecarPath(harness.sessionPath), harness.sessionPath).state.blocks.length, 0);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prompt-start guidance reaches the compression phase and ignored pressure is bounded", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-phase-budget-"));
  const projection = fixtureProjection(12, { messageChars: 1800 });
  const harness = extensionHarness(directory, () => projection, {
    emergency: { enabled: true, maxAttemptsPerTurn: 2 },
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow: windowForUsage(projection, 96) }),
  });
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    assert.match(harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx).systemPrompt, /emergency pressure/);
    const context = () => harness.handlers.get("context")({ messages: projection.messages }, harness.ctx);
    const gate = harness.handlers.get("tool_call");
    for (let i = 1; i <= 6; i++) {
      const phasePrompt = context().messages.at(-1).content[0].text;
      assert.match(phasePrompt, new RegExp(`request ${i}/6`));
      assert.match(phasePrompt, /next response must be a tool call/i);
      assert.match(phasePrompt, /"sourceType":"raw"/);
      assert.match(phasePrompt, /Do not repeat discovery after it returns candidates/i);
      assert.equal(gate({ toolName: "bash" }, harness.ctx).block, true);
      assert.deepEqual(harness.handlers.get("session_before_compact")({ reason: "threshold" }, harness.ctx), { cancel: true });
    }
    const exhausted = context();
    assert.match(exhausted.messages.at(-1).content[0].text, /budget is exhausted/i);
    assert.match(exhausted.messages.at(-1).content[0].text, /handed to Pi native compaction/i);
    assert.equal(gate({ toolName: "bash" }, harness.ctx), undefined,
      "ordinary task tools are released as soon as the compression budget is exhausted");
    assert.equal(gate({ toolName: "big_pi_compression_sources" }, harness.ctx).block, true,
      "compression tools are paused while native fallback owns recovery");
    assert.equal(harness.handlers.get("session_before_compact")({ reason: "threshold" }, harness.ctx), undefined,
      "Pi native compaction owns recovery immediately after budget exhaustion");
    for (let i = 0; i < 95; i++) {
      assert.equal(gate({ toolName: "read" }, harness.ctx), undefined,
        `repeated task-tool call ${i + 1} must not re-enter the deadlock`);
      assert.equal(gate({ toolName: "big_pi_compress" }, harness.ctx).block, true,
        `repeated compression call ${i + 1} must remain paused during fallback`);
    }
    context();
    assert.equal(gate({ toolName: "read" }, harness.ctx), undefined,
      "a later context request must not restart the compression gate during Pi fallback");
    harness.handlers.get("agent_end")({}, harness.ctx);
    assert.equal(gate({ toolName: "bash" }, harness.ctx), undefined);
    assert.equal(harness.handlers.get("session_before_compact")({ reason: "threshold" }, harness.ctx), undefined);
    const saved = readState(sidecarPath(harness.sessionPath), harness.sessionPath).state;
    assert.equal(saved.blocks.length, 0);
    assert.equal(saved.compression.emergency.projections[saved.metrics.growthProjectionId].nativeFallbackState, "pending");
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("emergency guidance advances from source discovery directly to the returned candidate", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-phase-step-"));
  const projection = fixtureProjection(12, { messageChars: 1800 });
  const harness = extensionHarness(directory, () => projection, {
    emergency: { enabled: true, maxAttemptsPerTurn: 2 },
    getContextUsage: () => ({ tokens: estimateTokens(projection.messages), contextWindow: windowForUsage(projection, 96) }),
  });
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    harness.handlers.get("before_agent_start")({ systemPrompt: "base" }, harness.ctx);
    const context = () => harness.handlers.get("context")({ messages: projection.messages }, harness.ctx);
    const first = context().messages.at(-1).content[0].text;
    assert.match(first, /call big_pi_compression_sources with \{"sourceType":"raw"\}/);

    const listed = await harness.tools.get("big_pi_compression_sources")
      .execute("discover", { sourceType: "raw" }, undefined, undefined, harness.ctx);
    const candidate = JSON.parse(listed.content[0].text).eligibleRanges[0];
    assert.ok(candidate?.candidateId);

    const next = context().messages.at(-1).content[0].text;
    assert.match(next, /Source discovery already succeeded/);
    assert.match(next, /Do not call big_pi_compression_sources again/);
    assert.ok(next.includes(candidate.candidateId));
    assert.match(next, new RegExp(`minimum ${candidate.minimumSummaryTokens} tokens`));
    assert.match(next, /call big_pi_compress/i);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a normal growth nudge never creates a session-scoped compression gate", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "big-pi-phase-scope-"));
  const projection = fixtureProjection(8, { messageChars: 12000 });
  let selected = path.join(directory, "session.jsonl");
  const harness = extensionHarness(directory, () => projection, { growthTriggerTokens: 500, getSessionPath: () => selected });
  try {
    await harness.handlers.get("session_start")({}, harness.ctx);
    const baseline = readState(sidecarPath(selected), selected).state.metrics.effectiveTransformedContextTokensEstimate;
    setProjectionGrowth(projection, baseline, 500, "scope-growth");
    harness.handlers.get("context")({ messages: projection.messages }, harness.ctx);
    const gate = harness.handlers.get("tool_call");
    assert.equal(gate({ toolName: "bash" }, harness.ctx), undefined);
    selected = path.join(directory, "other.jsonl");
    assert.equal(gate({ toolName: "bash" }, harness.ctx), undefined);
    selected = harness.sessionPath;
    harness.handlers.get("agent_end")({}, harness.ctx);
    assert.equal(gate({ toolName: "bash" }, harness.ctx), undefined);
  } finally {
    restoreHarnessConfig(harness);
    rmSync(directory, { recursive: true, force: true });
  }
});
