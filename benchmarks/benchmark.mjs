#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAppendQueue } from "./io.mjs";
import { readBillionContextPiSummary } from "./billion-context-pi.mjs";
import { flattenWorkContextMetrics, summarizeWorkContext, workTurnContext } from "./benchmark-metrics.mjs";

const DEFAULT_TIMEOUT_MS = 120 * 60 * 1000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
let requestedSignal = null;
let activeChildProcess = null;

function stopChildProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => { try { child.kill("SIGTERM"); } catch { /* already exited */ } });
  } else {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }
  }, 5_000);
  forceTimer.unref();
}

function handleTerminationSignal(signal) {
  if (requestedSignal) return;
  requestedSignal = signal;
  console.error(`\n${signal} received; stopping the active benchmark run so it can be resumed.`);
  stopChildProcess(activeChildProcess);
}

process.on("SIGINT", () => handleTerminationSignal("SIGINT"));
process.on("SIGTERM", () => handleTerminationSignal("SIGTERM"));

function parseArgs(argv) {
  const options = { pi: process.platform === "win32" ? "pi.cmd" : "pi", runs: 1, timeoutMs: DEFAULT_TIMEOUT_MS };
  const valued = new Map([
    ["--prompts", "prompts"], ["--extension", "extension"], ["--billion-context-pi", "billionContextPiExtension"], ["--include-billion-context-pi", "includeBillionContextPi"], ["--config", "config"],
    ["--runs-dir", "runsDir"], ["--projects-dir", "projectsDir"], ["--pi", "pi"], ["--model", "model"],
    ["--label", "label"], ["--runs", "runs"], ["--timeout-minutes", "timeoutMinutes"],
    ["--config-set", "configSet"],
  ]);
  options.piArgs = [];
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--help" || key === "-h") { options.help = true; continue; }
    if (key === "--all-configs") { options.allConfigs = true; continue; }
    if (key === "--resume") { options.resume = true; continue; }
    if (key === "--stock-pi") { options.stockPi = true; continue; }
    if (key === "--include-stock") { options.includeStock = true; continue; }
    if (key === "--pi-arg") {
      const value = argv[++i];
      if (!value) throw new Error("Expected a value after --pi-arg");
      options.piArgs.push(value);
      continue;
    }
    if (!valued.has(key)) throw new Error(`Unknown option: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Expected a value after ${key}`);
    options[valued.get(key)] = value;
  }
  if (options.runs !== undefined) {
    options.runs = Number(options.runs);
    if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 100) throw new Error("--runs must be an integer from 1 to 100");
  }
  if (options.timeoutMinutes !== undefined) {
    const minutes = Number(options.timeoutMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("--timeout-minutes must be greater than zero");
    options.timeoutMs = minutes * 60_000;
  }
  if (options.allConfigs && options.configSet) throw new Error("Use either --all-configs or --config-set, not both");
  if ((options.allConfigs || options.configSet) && options.config) throw new Error("Use either --config or a config set, not both");
  return options;
}

function usage() {
  return `Big Pi benchmark (standalone; no repo changes required)

Usage:
  node benchmark.mjs --prompts prompts.json --extension PATH [options]
  node benchmark.mjs --prompts prompts.json --stock-pi [options]

Required:
  --prompts FILE       JSON prompt set (array of strings or {"prompts": [...]})
  --extension PATH     Big Pi extension entry file, usually big-pi/index.js
  --billion-context-pi PATH  Run one case with only Billion Context Pi loaded
  --include-billion-context-pi PATH  Add a BCP-only case to a config grid
  --stock-pi           Run one stock Pi case without loading Big Pi or other extensions

Options:
  --config FILE        Big Pi JSON config to use for every run
  --config-set FILE    Run each named config in a JSON config set
  --all-configs        Run the shipped 80k-context config set
  --include-stock      Add a stock Pi baseline to a config-set/grid run
  --resume             Resume a grid: keep finished entries and replace an interrupted run
  --runs-dir DIR       Output root; default ./runs
  --projects-dir DIR   Isolated Pi projects; default C:\\tmp\\big-pi on Windows
  --pi COMMAND         Pi command; default pi (Windows: pi.cmd)
  --pi-arg VALUE       Add an argument to the Pi command (repeatable)
  --model MODEL        Pass --model to Pi
  --runs N             Repeat the prompt set in N fresh project dirs (default 1)
  --label TEXT         Add a label to run directory names
  --timeout-minutes N  Whole-run wall timeout (default 120)

Each run saves Pi's session, event JSONL, and summary.json; Big Pi runs also save Big Pi storage and debug logs. Stock Pi runs use --no-extensions and omit the explicit Big Pi extension, even if Big Pi is installed globally. BCP runs use --no-extensions and load only the explicit Billion Context Pi extension path.
With --resume, use the same prompts/config set/model/extension and output directories. Finished entries are kept; an interrupted entry's partial run/project directories are removed and that entry is rerun in a fresh project directory. Timeout failures remain recorded and are not retried automatically.
`;
}

async function loadConfigSet(file) {
  const configSetPath = path.resolve(file);
  const parsed = JSON.parse(await readFile(configSetPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.configurations) || parsed.configurations.length === 0) {
    throw new Error("Config set must be an object with a non-empty configurations array");
  }
  const seen = new Set();
  const configurations = parsed.configurations.map((entry, index) => {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id) throw new Error(`Config set entry ${index + 1} must have a non-empty id`);
    if (seen.has(id)) throw new Error(`Config set contains duplicate id: ${id}`);
    seen.add(id);
    if (entry.config && typeof entry.config === "object" && !Array.isArray(entry.config)) {
      return { id, description: typeof entry.description === "string" ? entry.description : null, config: entry.config };
    }
    if (typeof entry.configFile === "string" && entry.configFile.trim()) {
      return { id, description: typeof entry.description === "string" ? entry.description : null, configPath: path.resolve(path.dirname(configSetPath), entry.configFile) };
    }
    throw new Error(`Config set entry ${id} must have a config object or configFile`);
  });
  return {
    name: typeof parsed.name === "string" ? parsed.name : path.basename(configSetPath),
    targetContextWindowTokens: Number.isFinite(parsed.targetContextWindowTokens) ? parsed.targetContextWindowTokens : null,
    sourcePath: configSetPath,
    configurations,
  };
}

async function loadPrompts(file) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  const values = Array.isArray(parsed) ? parsed : parsed?.prompts;
  if (!Array.isArray(values) || values.length === 0) throw new Error("Prompt set must be a non-empty JSON array or an object with a non-empty prompts array");
  return values.map((entry, index) => {
    const text = typeof entry === "string" ? entry : entry?.text ?? entry?.prompt;
    if (typeof text !== "string" || !text.trim()) throw new Error(`Prompt ${index + 1} must be a non-empty string (or have a text field)`);
    return { id: typeof entry === "object" && typeof entry.id === "string" ? entry.id : `prompt-${index + 1}`, text };
  });
}

function safeName(value) {
  return String(value).normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "run";
}

function jsonLine(record) { return `${JSON.stringify(record)}\n`; }

function formatTokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "?";
}

function formatContextUsage(usage) {
  return `${formatTokenCount(usage?.tokens).padStart(7)} / ${formatTokenCount(usage?.contextWindow).padStart(7)} tokens`;
}

function durationUnion(intervals, now = Date.now()) {
  const sorted = intervals.map(({ start, end }) => [start, end ?? now]).filter(([start, end]) => end >= start).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let current;
  for (const interval of sorted) {
    if (!current || interval[0] > current[1]) {
      if (current) total += current[1] - current[0];
      current = [...interval];
    } else current[1] = Math.max(current[1], interval[1]);
  }
  if (current) total += current[1] - current[0];
  return Math.round(total);
}

function parseDebugEvents(text) {
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function countTiers(blocks = []) {
  const tiers = { "1": 0, "2": 0, "3": 0 };
  for (const block of blocks) if (tiers[String(block.tier)] !== undefined) tiers[String(block.tier)]++;
  return tiers;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return undefined; }
}

async function findPiSession(sessionDir) {
  try {
    const entries = await readdir(sessionDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.endsWith(".big-pi-debug.jsonl"));
    if (files.length !== 1) return undefined;
    return path.join(sessionDir, files[0].name);
  } catch { return undefined; }
}

async function runOne(options, prompts, runIndex) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const label = safeName(options.label ?? "");
  const runDir = options.runDir ?? path.resolve(options.runsDir, `${timestamp}-${label ? `${label}-` : ""}run-${String(runIndex).padStart(2, "0")}`);
  const projectDir = options.projectDir ?? path.join(runDir, "project");
  const sessionDir = path.join(runDir, "sessions");
  await mkdir(projectDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const eventFile = path.join(runDir, "events.jsonl");
  const rpcOutputFile = path.join(runDir, "pi-rpc-stdout.jsonl");
  const stderrFile = path.join(runDir, "pi-stderr.log");
  const stdoutFile = path.join(runDir, "pi-stdout-unparsed.log");
  let sourceConfigPath = null;
  let configPath = null;
  let configHash = null;
  let extensionPath = null;
  if (options.billionContextPi) {
    extensionPath = path.resolve(options.billionContextPiExtension);
  } else if (!options.stockPi) {
    sourceConfigPath = options.configSourcePath ?? (options.config ? path.resolve(options.config) : path.join(ROOT, "examples", "baseline-config.json"));
    configPath = path.join(runDir, "big-pi-config.json");
    if (options.configObject) await writeFile(configPath, `${JSON.stringify(options.configObject, null, 2)}\n`);
    else await copyFile(sourceConfigPath, configPath);
    const configContents = await readFile(configPath);
    configHash = createHash("sha256").update(configContents).digest("hex");
    let parsedConfig;
    try { parsedConfig = JSON.parse(configContents.toString("utf8")); }
    catch (error) { throw new Error(`Invalid Big Pi config JSON at ${sourceConfigPath}: ${error.message}`); }
    if (!parsedConfig || typeof parsedConfig !== "object" || Array.isArray(parsedConfig)) throw new Error("Big Pi config must contain a JSON object");
    extensionPath = path.resolve(options.extension);
  }
  const args = [...options.piArgs, "--mode", "rpc", "--no-extensions", "--session-dir", sessionDir];
  if (extensionPath) args.push("--extension", extensionPath);
  if (options.model) args.push("--model", options.model);
  const env = { ...process.env, PI_CODING_AGENT_SESSION_DIR: sessionDir };
  for (const name of Object.keys(env)) if (name.startsWith("BIG_PI_")) delete env[name];
  if (!options.stockPi && !options.billionContextPi) Object.assign(env, {
    BIG_PI_CONFIG: configPath,
    BIG_PI_DEBUG: "1",
    BIG_PI_LOG_PATH: path.join(runDir, "big-pi.log"),
    BIG_PI_DUMP_DIR: path.join(runDir, "big-pi-dumps"),
  });
  const child = spawn(options.pi, args, { cwd: projectDir, env, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
  activeChildProcess = child;
  const stdoutEnded = new Promise((resolve) => child.stdout.once("end", resolve));
  const stderrEnded = new Promise((resolve) => child.stderr.once("end", resolve));
  const stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity });
  const pending = new Map();
  const compactions = [];
  const activeCompactions = [];
  const bigPiToolCalls = [];
  const activeBigPiTools = new Map();
  const eventErrors = [];
  const compactionFailures = [];
  const modelTurns = [];
  let assistantMessageStartedAt = null;
  let settleCount = 0;
  let settleWaiters = [];
  let stdoutText = "";
  let stderrText = "";
  const writes = createAppendQueue();
  let recoveryRetryPending = false;
  let queuedMessages = 0;
  let cancelledCompactions = 0;
  const stepWidth = String(prompts.length).length;
  const promptLabel = (index, prompt) => `[${String(index + 1).padStart(stepWidth)}/${prompts.length}] ${prompt.id}`;
  const promptColumnWidth = Math.max(...prompts.map((item, index) => promptLabel(index, item).length));
  const statusColumnWidth = Math.max(20, "initial request context measured".length, `settled: ${(options.timeoutMs / 1000).toFixed(1)}s`.length);
  const progressColumnWidth = Math.max(100, promptColumnWidth + 2 + statusColumnWidth);
  let lifecycleLogs = Promise.resolve();
  const pendingCompressionContextLogs = [];
  const pendingNativeCompactionUsageLogs = [];
  const promptProviderUsageLogged = new Set();
  let currentPrompt = null;
  const logProgress = (text, usage) => console.log(`  ${text.padEnd(progressColumnWidth)}  |  context [ ${formatContextUsage(usage)} ]`);
  function contextAtEvent() {
    return request("get_session_stats").then((response) => response.data?.contextUsage ?? null, () => null);
  }
  function logLifecycle(text, usage = contextAtEvent()) {
    // Capture context at the event; preserve log order without blocking RPC events.
    lifecycleLogs = lifecycleLogs.then(async () => logProgress(text, await usage));
  }
  function flushCompressionContextLogs() {
    if (!pendingCompressionContextLogs.length) return;
    const ended = pendingCompressionContextLogs.splice(0);
    const usage = request("get_session_stats").then((response) => response.data?.contextUsage ?? null, () => null);
    lifecycleLogs = lifecycleLogs.then(async () => {
      const contextUsage = await usage;
      for (const text of ended) logProgress(`${text} (context after turn settled)`, contextUsage);
    });
  }
  let sessionFile;
  let effectiveModel;
  let piAutoCompactionEnabled;
  let stateAtTimeout;
  let childExit;
  let childError;
  const startedAt = Date.now();
  let nextId = 1;

  const flushAppend = (file, text) => { if (text) writes.append(file, text); };
  const recordEvent = (record) => {
    writes.append(eventFile, jsonLine({ receivedAt: new Date().toISOString(), ...record }));
  };

  stdoutLines.on("line", (line) => {
    writes.append(rpcOutputFile, `${line}\n`);
    let record;
    try { record = JSON.parse(line); } catch {
      stdoutText += `${line}\n`;
      void flushAppend(stdoutFile, `${line}\n`);
      return;
    }
    void recordEvent(record);
    if (record.type === "response" && record.id && pending.has(record.id)) {
      const request = pending.get(record.id);
      pending.delete(record.id);
      clearTimeout(request.timer);
      if (record.success) request.resolve(record);
      else request.reject(new Error(record.error ?? `Pi RPC ${record.command} failed`));
    }
    if (record.type === "agent_start" || record.type === "turn_start") recoveryRetryPending = false;
    if (record.type === "message_start" && record.message?.role === "assistant") assistantMessageStartedAt = Date.now();
    if (record.type === "turn_end" && record.message?.role === "assistant") {
      const durationMs = assistantMessageStartedAt == null ? null : Date.now() - assistantMessageStartedAt;
      assistantMessageStartedAt = null;
      const usage = workTurnContext(record.message, new Date().toISOString());
      if (usage) {
        modelTurns.push(usage);
        if (currentPrompt && !promptProviderUsageLogged.has(currentPrompt.index)) {
          promptProviderUsageLogged.add(currentPrompt.index);
          const label = promptLabel(currentPrompt.index, currentPrompt.prompt);
          logLifecycle(`${label.padEnd(promptColumnWidth)}  ${"initial request context measured".padEnd(statusColumnWidth)}`, {
            tokens: usage.promptContextTokens,
            contextWindow: effectiveModel?.contextWindow ?? null,
          });
        }
        while (pendingNativeCompactionUsageLogs.length) {
          const pending = pendingNativeCompactionUsageLogs.shift();
          const label = pending.stepLabel ?? "Pi session";
          logLifecycle(`${label} continued after Pi compaction`, {
            tokens: usage.promptContextTokens,
            contextWindow: effectiveModel?.contextWindow ?? null,
          });
        }
      }
    }
    if (record.type === "queue_update") queuedMessages = (record.steering?.length ?? 0) + (record.followUp?.length ?? 0);
    if (record.type === "agent_settled") {
      settleCount++;
      // Do not let a compaction with no following provider usage borrow the next prompt's counts.
      pendingNativeCompactionUsageLogs.length = 0;
      const waiters = settleWaiters;
      settleWaiters = [];
      for (const resolve of waiters) resolve();
      // Compression's tool event can end before Pi has rebuilt the next request.
      // At agent_settled, session stats reflect the post-compression context.
      flushCompressionContextLogs();
    }
    if (record.type === "session_start" && record.sessionFile) sessionFile = record.sessionFile;
    if (record.type === "compaction_start") {
      const active = { start: Date.now(), reason: record.reason ?? null, contextAtStart: contextAtEvent() };
      active.logged = true;
      logLifecycle(`${new Date(active.start).toISOString()} Pi compaction started${record.reason ? ` (${record.reason})` : ""}`, active.contextAtStart);
      activeCompactions.push(active);
    }
    if (record.type === "compaction_end") {
      const active = activeCompactions.shift();
      if (active) clearTimeout(active.timer);
      recoveryRetryPending = record.willRetry === true;
      const end = Date.now();
      if (record.errorMessage) {
        const failure = { at: new Date(end).toISOString(), reason: record.reason ?? active?.reason ?? null, error: String(record.errorMessage).slice(0, 500) };
        compactionFailures.push(failure);
        eventErrors.push({ at: failure.at, type: "compaction", error: failure.error });
      }
      compactions.push({ start: active?.start ?? end, end, durationMs: active ? end - active.start : 0, reason: record.reason ?? active?.reason ?? null, aborted: record.aborted === true, willRetry: record.willRetry === true, contextAtStart: active?.contextAtStart ?? null });
      if (!record.aborted && !record.errorMessage) {
        pendingNativeCompactionUsageLogs.push({
          stepLabel: currentPrompt ? promptLabel(currentPrompt.index, currentPrompt.prompt) : null,
        });
      }
      if (record.aborted) {
        cancelledCompactions++;
        if (cancelledCompactions === 1) logLifecycle(`Pi compaction cancelled (${record.reason ?? active?.reason ?? "unknown"}); repeats counted in summary`, active?.contextAtStart ?? contextAtEvent());
      } else {
        if (active && !active.logged) logLifecycle(`${new Date(active.start).toISOString()} Pi compaction started (${active.reason ?? "unknown"})`, active.contextAtStart);
        logLifecycle(`${new Date(end).toISOString()} Pi compaction ${record.aborted ? "aborted" : record.errorMessage ? "failed" : "ended"}${active ? ` in ${((end - active.start) / 1000).toFixed(1)}s` : ""}${record.willRetry ? " (retry pending)" : ""}`);
      }
    }
    if (record.type === "tool_execution_start" && typeof record.toolName === "string" && record.toolName.startsWith("big_pi_")) {
      activeBigPiTools.set(record.toolCallId ?? `${record.toolName}-${Date.now()}`, { start: Date.now(), toolName: record.toolName });
      if (record.toolName === "big_pi_compress") logLifecycle(`${new Date().toISOString()} Big Pi compression started`);
    }
    if (record.type === "tool_execution_end" && typeof record.toolName === "string" && record.toolName.startsWith("big_pi_")) {
      const key = record.toolCallId;
      const active = key ? activeBigPiTools.get(key) : [...activeBigPiTools.values()].find((tool) => tool.toolName === record.toolName);
      if (key) activeBigPiTools.delete(key);
      else if (active) {
        for (const [activeKey, tool] of activeBigPiTools) if (tool === active) activeBigPiTools.delete(activeKey);
      }
      const end = Date.now();
      bigPiToolCalls.push({ toolCallId: record.toolCallId ?? null, toolName: record.toolName, start: active?.start ?? end, end, durationMs: active ? end - active.start : 0, isCompression: record.toolName === "big_pi_compress" });
      if (record.toolName === "big_pi_compress") {
        const endedAt = new Date(end).toISOString();
        const duration = active ? ` in ${((end - active.start) / 1000).toFixed(1)}s` : "";
        logLifecycle(`${endedAt} Big Pi compression ended${duration} (context refresh pending)`);
        pendingCompressionContextLogs.push(`${endedAt} Big Pi compression context refreshed`);
      }
    }
    if (record.type === "agent_end" && record.errorMessage) eventErrors.push({ at: new Date().toISOString(), error: String(record.errorMessage).slice(0, 500) });
  });
  stderrLines.on("line", (line) => { stderrText += `${line}\n`; void flushAppend(stderrFile, `${line}\n`); });
  child.on("exit", (code, signal) => {
    childExit = { code, signal, at: new Date().toISOString() };
    const error = new Error(`Pi process exited with ${signal ?? `code ${code}`}`);
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(error);
      pending.delete(id);
    }
  });
  child.on("error", (error) => {
    childError = error;
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(error);
      pending.delete(id);
    }
  });

  function request(type, data = {}) {
    const id = `bench-${nextId++}`;
    const promise = new Promise((resolve, reject) => {
      const request = { resolve, reject, timer: undefined };
      request.timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out waiting for Pi RPC ${type}`)); }, 30_000);
      pending.set(id, request);
    });
    child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    return promise;
  }

  function waitForSettled(afterCount, promptId) {
    return new Promise((resolve, reject) => {
      if (settleCount > afterCount) { resolve(); return; }
      let settled = false;
      const remainingMs = Math.max(0, options.timeoutMs - (Date.now() - startedAt));
      const cleanup = () => child.removeListener("exit", onExit);
      const onExit = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Pi exited before prompt ${promptId} settled`));
      };
      const timer = setTimeout(async () => {
        if (settled) return;
        settled = true;
        cleanup();
        try { stateAtTimeout = (await request("get_state")).data; } catch { /* Pi may already have exited. */ }
        const error = new Error(`Benchmark run exceeded the ${Math.round(options.timeoutMs / 60_000)} minute timeout while waiting for prompt ${promptId}`);
        error.code = "PROMPT_TIMEOUT";
        reject(error);
      }, remainingMs);
      settleWaiters.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve();
      });
      child.once("exit", onExit);
    });
  }

  let fatalError;
  const promptResults = [];
  try {
    if (childError) throw childError;
    const initial = await request("get_state");
    sessionFile = initial.data?.sessionFile;
    effectiveModel = initial.data?.model ? { provider: initial.data.model.provider, id: initial.data.model.id, contextWindow: initial.data.model.contextWindow } : null;
    piAutoCompactionEnabled = initial.data?.autoCompactionEnabled;
    const runTitle = options.configId
      ? `Run ${runIndex}/${options.runs} [${options.configId}]`
      : `Run ${runIndex}/${options.runs}`;
    console.log(`${runTitle}: ${prompts.length} prompts${options.stockPi ? "; stock Pi compaction" : ""}${effectiveModel?.id ? `; model ${effectiveModel.provider}/${effectiveModel.id}` : options.model ? `; model ${options.model}` : ""}`);
    const logPromptProgress = async (index, prompt, status, usage) => {
      await lifecycleLogs;
      const label = promptLabel(index, prompt);
      logProgress(`${label.padEnd(promptColumnWidth)}  ${status.padEnd(statusColumnWidth)}`, usage);
    };
    for (let index = 0; index < prompts.length; index++) {
      const prompt = prompts[index];
      currentPrompt = { index, prompt };
      if (Date.now() - startedAt >= options.timeoutMs) {
        const error = new Error(`Benchmark run exceeded the ${Math.round(options.timeoutMs / 60_000)} minute timeout before prompt ${prompt.id}`);
        error.code = "PROMPT_TIMEOUT";
        throw error;
      }
      const baseline = settleCount;
      const compactionFailureBaseline = compactionFailures.length;
      const promptStarted = Date.now();
      let contextBefore = null;
      try {
        const stats = (await request("get_session_stats")).data;
        contextBefore = stats?.contextUsage ?? null;
      } catch { /* Model/context usage may not be available yet. */ }
      await logPromptProgress(index, prompt, "sending", contextBefore);
      const response = await request("prompt", { message: prompt.text });
      const disposition = response.data?.disposition;
      if (disposition !== "handled") await waitForSettled(baseline, prompt.id);
      // A settled event may precede a queued recovery turn. Confirm Pi is idle.
      while (true) {
        const state = (await request("get_state")).data;
        if (state?.isStreaming === false && state?.isCompacting === false &&
            (state.pendingMessageCount ?? queuedMessages) === 0 &&
            activeCompactions.length === 0 && activeBigPiTools.size === 0 && !recoveryRetryPending) break;
        if (Date.now() - startedAt >= options.timeoutMs) {
          const error = new Error(`Benchmark run timed out waiting for recovery after prompt ${prompt.id}`);
          error.code = "PROMPT_TIMEOUT";
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const promptEnded = Date.now();
      let contextAfter = null;
      try {
        const stats = (await request("get_session_stats")).data;
        contextAfter = stats?.contextUsage ?? null;
      } catch { /* Model/context usage may not be available yet. */ }
      const promptFailures = compactionFailures.slice(compactionFailureBaseline);
      const failure = promptFailures.length ? {
        code: "PI_COMPACTION_FAILED",
        message: promptFailures.map((item) => item.error).join("; "),
      } : null;
      promptResults.push({ index: index + 1, id: prompt.id, disposition: disposition ?? null, durationMs: promptEnded - promptStarted, settled: true, completed: !failure, ...(failure ? { failure, compactionFailures: promptFailures } : {}), contextBefore, contextAfter });
      await logPromptProgress(index, prompt, `settled: ${((promptEnded - promptStarted) / 1000).toFixed(1)}s${failure ? ` (Pi compaction failed: ${promptFailures.length})` : ""}`, contextAfter);
      currentPrompt = null;
    }
  } catch (error) {
    fatalError = requestedSignal
      ? { message: `Benchmark interrupted by ${requestedSignal}`, code: "INTERRUPTED" }
      : { message: error.message, code: error.code ?? null };
    const last = promptResults.length;
    if (error.code === "PROMPT_TIMEOUT") promptResults.push({ index: last + 1, id: prompts[last]?.id, completed: false, timeout: true });
    console.error(`  ${requestedSignal ? "Run interrupted" : "Run stopped"}${options.configId ? ` [${options.configId}]` : ""}: ${fatalError.message}`);
  } finally {
    if (!fatalError) await lifecycleLogs;
    if (fatalError) stopChildProcess(child);
    else child.stdin.end();
    if (!childExit) await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    await Promise.all([stdoutEnded, stderrEnded]);
    await lifecycleLogs;
    if (activeChildProcess === child) activeChildProcess = null;
    stdoutLines.close();
    stderrLines.close();
    for (const active of activeCompactions) clearTimeout(active.timer);
    try { await writes.flush(); }
    catch (error) {
      fatalError ??= { message: `Unable to persist benchmark logs: ${error.message}`, code: error.code ?? null };
      console.error(`  Run stopped: ${fatalError.message}`);
    }
  }

  sessionFile ??= await findPiSession(sessionDir);
  let manifest;
  let bigPiEvents = [];
  if (sessionFile) {
    manifest = await readJson(path.join(`${sessionFile}.big-pi`, "manifest.json"));
    try { bigPiEvents = parseDebugEvents(await readFile(`${sessionFile}.big-pi-debug.jsonl`, "utf8")); } catch { /* no session events */ }
  }
  const billionContextPi = options.billionContextPi ? await readBillionContextPiSummary(sessionFile) : null;
  const blocks = Array.isArray(manifest?.blocks) ? manifest.blocks : [];
  await Promise.all(compactions.map(async (item) => { item.contextAtStart = await item.contextAtStart; }));
  const debugCounts = Object.fromEntries([...new Set(bigPiEvents.map((event) => event.event))].map((name) => [name, bigPiEvents.filter((event) => event.event === name).length]));
  const blockTierCounts = countTiers(blocks);
  const openCompactions = activeCompactions.map(({ start, reason }) => ({ start, reason, end: null, durationMs: Date.now() - start }));
  const openBigPiTools = [...activeBigPiTools.values()].map((item) => ({ ...item, end: null, durationMs: Date.now() - item.start }));
  const appliedCompressionCallIds = new Set(bigPiEvents
    .filter((event) => event.event === "compression_applied" && typeof event.toolCallId === "string")
    .map((event) => event.toolCallId));
  const compressionAttempts = [...bigPiToolCalls, ...openBigPiTools].filter((item) => item.toolName === "big_pi_compress");
  const otherBigPiTools = [...bigPiToolCalls, ...openBigPiTools].filter((item) => item.toolName !== "big_pi_compress");
  const successfulCompressionIntervals = compressionAttempts
    .filter((item) => item.toolCallId && appliedCompressionCallIds.has(item.toolCallId))
    .map(({ start, end }) => ({ start, end }));
  const compressionAttemptIntervals = compressionAttempts.map(({ start, end }) => ({ start, end }));
  const otherBigPiToolIntervals = otherBigPiTools.map(({ start, end }) => ({ start, end }));
  const allBigPiToolIntervals = [...compressionAttemptIntervals, ...otherBigPiToolIntervals];
  const compactionIntervals = [...compactions.map(({ start, end }) => ({ start, end })), ...openCompactions, ...compressionAttemptIntervals];
  const totalCompactionMs = durationUnion(compactionIntervals);
  const modelContextUsage = summarizeWorkContext(modelTurns);
  const result = {
    schemaVersion: 1,
    label: options.label ?? null,
    configId: options.configId ?? null,
    benchmarkMode: options.stockPi ? "stock-pi" : options.billionContextPi ? "billion-context-pi" : "big-pi",
    configDescription: options.configDescription ?? null,
    configSet: options.configSetName ?? null,
    targetContextWindowTokens: options.targetContextWindowTokens ?? null,
    runIndex,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    projectDir,
    sessionDir,
    sessionFile: sessionFile ?? null,
    extensionPath,
    configPath,
    sourceConfigPath,
    configSha256: configHash,
    model: options.model ?? null,
    effectiveModel: effectiveModel ?? null,
    piAutoCompactionEnabled: piAutoCompactionEnabled ?? null,
    promptCount: prompts.length,
    prompts: promptResults,
    completion: { completedPrompts: promptResults.filter((item) => item.completed).length, settledPrompts: promptResults.filter((item) => item.settled).length, promptFailures: promptResults.filter((item) => item.failure).map(({ index, id, failure }) => ({ index, id, ...failure })), stuck: Boolean((fatalError && !requestedSignal) || openCompactions.length || (childExit && childExit.code !== 0 && !fatalError)), interrupted: Boolean(requestedSignal), failure: fatalError, stateAtTimeout: stateAtTimeout ? { isStreaming: stateAtTimeout.isStreaming, isCompacting: stateAtTimeout.isCompacting, messageCount: stateAtTimeout.messageCount } : null, process: childExit ?? null },
    contextLimitExceeded: promptResults.some((item) => {
      const usage = item.contextAfter;
      return usage && ((typeof usage.percent === "number" && usage.percent > 100) || (typeof usage.tokens === "number" && typeof usage.contextWindow === "number" && usage.tokens > usage.contextWindow));
    }),
    piCompactions: { count: compactions.length, cancelledCount: compactions.filter((item) => item.aborted).length, intervals: compactions.map(({ start, end, ...item }) => item), peakContextAtStartTokens: Math.max(0, ...compactions.map((item) => item.contextAtStart?.tokens ?? 0)) || null, openAtStop: openCompactions.length, timeMs: durationUnion([...compactions.map(({ start, end }) => ({ start, end })), ...openCompactions]) },
    bigPiToolCalls: {
      calls: bigPiToolCalls.map(({ start, end, ...item }) => ({ ...item, compressionApplied: item.isCompression && item.toolCallId ? appliedCompressionCallIds.has(item.toolCallId) : null })),
      openAtStop: openBigPiTools.length,
      compressionTimeMs: durationUnion(compressionAttemptIntervals),
      compressionAttemptTimeMs: durationUnion(compressionAttemptIntervals),
      successfulCompressionTimeMs: durationUnion(successfulCompressionIntervals),
      otherToolTimeMs: durationUnion(otherBigPiToolIntervals),
      allBigPiToolTimeMs: durationUnion(allBigPiToolIntervals),
      successfulCalls: compressionAttempts.filter((item) => item.toolCallId && appliedCompressionCallIds.has(item.toolCallId)).length,
      unsuccessfulOrUnconfirmedCalls: compressionAttempts.filter((item) => !item.toolCallId || !appliedCompressionCallIds.has(item.toolCallId)).length,
    },
    estimatedCompactionTimeLostMs: totalCompactionMs,
    modelContextUsage,
    bigPi: {
      debugEventCounts: debugCounts,
      compressionPhases: {
        started: bigPiEvents.filter((event) => event.event === "compression_phase_started").length,
        committed: bigPiEvents.filter((event) => event.event === "compression_phase_ended" && event.outcome === "committed").length,
        unsuccessful: bigPiEvents.filter((event) => event.event === "compression_phase_ended" && event.outcome !== "committed").length,
      },
      appliedBlocksByTier: Object.fromEntries(["1", "2", "3"].map((tier) => [tier, bigPiEvents.filter((event) => event.event === "compression_applied" && String(event.tier) === tier).length])),
      committedBlocks: blocks.length,
      committedBlocksByTier: blockTierCounts,
      committedBlocksByStatus: Object.fromEntries([...new Set(blocks.map((block) => block.status ?? "unknown"))].map((status) => [status, blocks.filter((block) => block.status === status).length])),
      storageMetrics: manifest?.compression ?? null,
    },
    billionContextPi,
    errors: eventErrors,
    artifacts: {
      eventFile,
      rpcOutputFile,
      stderrFile,
      stdoutFile,
      bigPiLogFile: !options.stockPi && !options.billionContextPi ? path.join(runDir, "big-pi.log") : null,
      bigPiRotatedLogFile: !options.stockPi && !options.billionContextPi ? path.join(runDir, "big-pi.log.1") : null,
      bigPiContextDumpsDir: !options.stockPi && !options.billionContextPi ? path.join(runDir, "big-pi-dumps") : null,
      bigPiDebugFile: !options.stockPi && !options.billionContextPi && sessionFile ? `${sessionFile}.big-pi-debug.jsonl` : null,
      bigPiManifestFile: !options.stockPi && !options.billionContextPi && sessionFile ? path.join(`${sessionFile}.big-pi`, "manifest.json") : null,
      billionContextPiSidecarFile: options.billionContextPi && sessionFile ? `${sessionFile}.acp.json` : null,
    },
  };
  await writeFile(path.join(runDir, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`  Results: ${runDir}`);
  const tierSummary = billionContextPi ? `; Billion Context Pi blocks T1/T2/T3 ${billionContextPi.blocksByTier?.["1"] ?? "?"}/${billionContextPi.blocksByTier?.["2"] ?? "?"}/${billionContextPi.blocksByTier?.["3"] ?? "?"} (total ${billionContextPi.totalBlocks ?? "?"}; ${billionContextPi.manifestStatus})` : `; committed blocks T1/T2/T3 ${blockTierCounts["1"]}/${blockTierCounts["2"]}/${blockTierCounts["3"]}`;
  console.log(`  Prompts completed ${result.completion.completedPrompts}/${prompts.length} (${result.completion.settledPrompts} settled; ${result.completion.promptFailures.length} with Pi compaction errors)${tierSummary}; native Pi compactions ${compactions.filter((item) => !item.aborted).length}; compression phases committed/unsuccessful ${result.bigPi.compressionPhases.committed}/${result.bigPi.compressionPhases.unsuccessful}; Pi compaction time ${Math.round(totalCompactionMs / 1000)}s${fatalError || result.completion.promptFailures.length ? "; STUCK/FAILED" : ""}`);
  return result;
}

async function fileSha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function createResumeFingerprint(options, configSet, promptsPath) {
  const configFiles = await Promise.all(configSet.configurations
    .filter((configuration) => configuration.configPath)
    .map(async (configuration) => ({
      id: configuration.id,
      path: path.resolve(configuration.configPath),
      sha256: await fileSha256(path.resolve(configuration.configPath)),
    })));
  const payload = {
    promptsSha256: await fileSha256(promptsPath),
    configSetSha256: await fileSha256(configSet.sourcePath),
    configFiles,
    extensionPath: path.resolve(options.extension),
    extensionSha256: await fileSha256(path.resolve(options.extension)),
    includeBillionContextPi: options.includeBillionContextPi ? path.resolve(options.includeBillionContextPi) : null,
    includeBillionContextPiSha256: options.includeBillionContextPi ? await fileSha256(path.resolve(options.includeBillionContextPi)) : null,
    model: options.model ?? null,
    pi: options.pi,
    piArgs: options.piArgs,
    runs: options.runs,
    label: options.label ?? null,
    includeStock: options.includeStock === true,
    runsDir: options.runsDir,
    projectsDir: options.projectsDir,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function runKey(configId, runIndex) { return `${configId}::${runIndex}`; }

function isWithinDirectory(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function removeInterruptedRun(runDir, projectDir, options) {
  if (runDir && isWithinDirectory(options.runsDir, runDir)) await rm(runDir, { recursive: true, force: true });
  if (projectDir && isWithinDirectory(options.projectsDir, projectDir)) await rm(projectDir, { recursive: true, force: true });
}

async function prepareResume(options, configSet, resumeFingerprint) {
  if (!options.allConfigs && !options.configSet) throw new Error("--resume requires --all-configs or --config-set");
  const matrixPath = path.join(options.runsDir, "matrix-summary.json");
  const previous = await readJson(matrixPath);
  if (!previous || !Array.isArray(previous.results)) throw new Error(`Cannot resume: no valid matrix summary at ${matrixPath}`);
  if (previous.resumeFingerprint && previous.resumeFingerprint !== resumeFingerprint) {
    throw new Error("Cannot resume: prompts, config set, extension, model, run count, or output directories differ from the saved matrix. Use the original command or a new --runs-dir.");
  }
  if (!previous.resumeFingerprint && (previous.configSetPath !== configSet.sourcePath || previous.expectedRuns !== configSet.configurations.length * options.runs)) {
    throw new Error("Cannot resume this older matrix: its config set or expected run count differs from the current command.");
  }
  let results = previous.results;
  const terminalKeys = new Set(results.filter((item) => item.status === "completed" || item.status === "failed").map((item) => runKey(item.configId, item.runIndex)));
  const interruptedKeys = new Set(results.filter((item) => item.status === "interrupted").map((item) => runKey(item.configId, item.runIndex)));
  const removedKeys = new Set();
  for (const item of results.filter((entry) => entry.status === "interrupted")) {
    const runDir = item.runDir ?? (item.summaryPath ? path.dirname(item.summaryPath) : null);
    let projectDir = item.projectDir;
    if (!projectDir && runDir) projectDir = (await readJson(path.join(runDir, "run-state.json")))?.projectDir;
    await removeInterruptedRun(runDir, projectDir, options);
    removedKeys.add(runKey(item.configId, item.runIndex));
  }
  for (const entry of await readdir(options.runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(options.runsDir, entry.name);
    const state = await readJson(path.join(runDir, "run-state.json"));
    if (!state || !["running", "interrupted"].includes(state.status)) continue;
    const key = runKey(state.configId, state.runIndex);
    if (terminalKeys.has(key) || removedKeys.has(key)) continue;
    await removeInterruptedRun(state.runDir ?? runDir, state.projectDir, options);
    interruptedKeys.add(key);
    removedKeys.add(key);
  }
  results = results.filter((item) => !removedKeys.has(runKey(item.configId, item.runIndex)));
  return { results, matrixStartedAt: previous.startedAt ?? new Date().toISOString(), interruptedKeys };
}

function matrixResultFromRun(result, runOptions, runIndex, status) {
  const prompts = Array.isArray(result.prompts) ? result.prompts : [];
  return {
    configId: runOptions.configId,
    configDescription: runOptions.configDescription ?? null,
    configSet: runOptions.configSetName,
    runIndex,
    benchmarkMode: runOptions.stockPi ? "stock-pi" : runOptions.billionContextPi ? "billion-context-pi" : "big-pi",
    status,
    completedPrompts: result.completion?.completedPrompts ?? 0,
    runDir: runOptions.runDir,
    projectDir: runOptions.projectDir,
    metrics: {
      elapsedMs: result.elapsedMs ?? 0,
      promptTimeMs: prompts.reduce((sum, item) => sum + (item.durationMs ?? 0), 0),
      peakContextTokens: Math.max(0, ...prompts.map((item) => item.contextAfter?.tokens ?? 0)),
      contextWindowTokens: result.effectiveModel?.contextWindow ?? null,
      compactionTimeMs: result.estimatedCompactionTimeLostMs ?? 0,
      compressionTimeMs: result.bigPiToolCalls?.compressionTimeMs ?? 0,
      compressionAttemptTimeMs: result.bigPiToolCalls?.compressionAttemptTimeMs ?? 0,
      successfulCompressionTimeMs: result.bigPiToolCalls?.successfulCompressionTimeMs ?? 0,
      otherBigPiToolTimeMs: result.bigPiToolCalls?.otherToolTimeMs ?? 0,
      allBigPiToolTimeMs: result.bigPiToolCalls?.allBigPiToolTimeMs ?? 0,
      successfulCompressionCalls: result.bigPiToolCalls?.successfulCalls ?? 0,
      unsuccessfulOrUnconfirmedCompressionCalls: result.bigPiToolCalls?.unsuccessfulOrUnconfirmedCalls ?? 0,
      workPromptContextTokens: result.modelContextUsage?.usageByTurnCategory?.work?.promptContextTokens ?? 0,
      workOutputTokens: result.modelContextUsage?.usageByTurnCategory?.work?.outputTokens ?? 0,
      compressionAttemptPromptContextTokens: result.modelContextUsage?.usageByTurnCategory?.compressionAttempt?.promptContextTokens ?? 0,
      compressionAttemptOutputTokens: result.modelContextUsage?.usageByTurnCategory?.compressionAttempt?.outputTokens ?? 0,
      otherBigPiToolPromptContextTokens: result.modelContextUsage?.usageByTurnCategory?.otherBigPiTool?.promptContextTokens ?? 0,
      otherBigPiToolOutputTokens: result.modelContextUsage?.usageByTurnCategory?.otherBigPiTool?.outputTokens ?? 0,
      mixedBigPiToolPromptContextTokens: result.modelContextUsage?.usageByTurnCategory?.compressionAndOtherBigPi?.promptContextTokens ?? 0,
      mixedBigPiToolOutputTokens: result.modelContextUsage?.usageByTurnCategory?.compressionAndOtherBigPi?.outputTokens ?? 0,
      nativeCompactions: result.piCompactions?.intervals?.filter((item) => !item.aborted).length ?? 0,
      committedBlocks: result.billionContextPi ? result.billionContextPi.totalBlocks : result.bigPi?.committedBlocks ?? 0,
      committedBlocksByTier: result.billionContextPi ? result.billionContextPi.blocksByTier : result.bigPi?.committedBlocksByTier ?? { "1": 0, "2": 0, "3": 0 },
      compressionPhasesCommitted: result.bigPi?.compressionPhases?.committed ?? 0,
      compressionPhasesUnsuccessful: result.bigPi?.compressionPhases?.unsuccessful ?? 0,
      ...flattenWorkContextMetrics(result.modelContextUsage),
      peakCompactionTriggerContextTokens: result.piCompactions?.peakContextAtStartTokens ?? null,
    },
    summaryPath: path.join(runOptions.runDir, "summary.json"),
    error: result.completion?.failure?.message ?? result.completion?.promptFailures?.[0]?.message ?? null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  if (!options.prompts || (!options.extension && !options.stockPi && !options.billionContextPiExtension)) throw new Error(`Missing required options.\n\n${usage()}`);
  if (options.stockPi && options.billionContextPiExtension) throw new Error("Choose either --stock-pi or --billion-context-pi");
  if (options.billionContextPiExtension && (options.extension || options.config || options.allConfigs || options.configSet || options.includeStock || options.includeBillionContextPi)) {
    throw new Error("--billion-context-pi is a standalone BCP-only run; omit Big Pi/grid options or use --include-billion-context-pi with a Big Pi grid.");
  }
  if (options.includeBillionContextPi && !(options.allConfigs || options.configSet)) throw new Error("--include-billion-context-pi requires --all-configs or --config-set");
  if (options.stockPi && (options.extension || options.config || options.allConfigs || options.configSet || options.includeStock)) {
    throw new Error("--stock-pi is a standalone no-extension run; omit --extension/--config and use --include-stock for a grid baseline.");
  }
  if (options.includeStock && !(options.allConfigs || options.configSet)) {
    throw new Error("--include-stock requires --all-configs or --config-set");
  }
  options.runsDir = path.resolve(options.runsDir ?? "runs");
  options.projectsDir = path.resolve(options.projectsDir ?? (process.platform === "win32" ? "C:\\tmp\\big-pi" : "/tmp/big-pi"));
  const promptsPath = path.resolve(options.prompts);
  const prompts = await loadPrompts(promptsPath);
  await mkdir(options.runsDir, { recursive: true });
  const isMatrixRun = options.allConfigs || options.configSet;
  const configSet = isMatrixRun
    ? await loadConfigSet(options.configSet ?? path.join(ROOT, "config-sets", "80k-context.json"))
    : options.stockPi ? {
      name: "stock-pi",
      targetContextWindowTokens: null,
      configurations: [{ id: "stock-pi", description: "Pi-native compaction without extensions", stockPi: true }],
    } : options.billionContextPiExtension ? {
      name: "billion-context-pi",
      targetContextWindowTokens: null,
      configurations: [{ id: safeName(options.label ?? "billion-context-pi"), description: "Billion Context Pi only", billionContextPi: true, extensionPath: path.resolve(options.billionContextPiExtension) }],
    } : {
      name: null,
      targetContextWindowTokens: null,
      configurations: [{ id: safeName(options.label ?? "single"), description: null, configPath: options.config ? path.resolve(options.config) : path.join(ROOT, "examples", "baseline-config.json") }],
    };
  if (options.includeStock) {
    if (configSet.configurations.some((configuration) => configuration.id === "stock-pi")) {
      throw new Error("Cannot add --include-stock because the config set already contains an ID named stock-pi");
    }
    configSet.configurations.push({ id: "stock-pi", description: "Pi-native compaction without extensions", stockPi: true });
  }
  if (options.includeBillionContextPi) {
    if (configSet.configurations.some((configuration) => configuration.id === "billion-context-pi")) throw new Error("Cannot add --include-billion-context-pi because the config set already contains an ID named billion-context-pi");
    configSet.configurations.push({ id: "billion-context-pi", description: "Billion Context Pi only", billionContextPi: true, extensionPath: path.resolve(options.includeBillionContextPi) });
  }
  if (options.resume && !isMatrixRun) throw new Error("--resume requires --all-configs or --config-set");
  const resumeFingerprint = isMatrixRun ? await createResumeFingerprint(options, configSet, promptsPath) : null;
  let results = [];
  let matrixStartedAt = new Date().toISOString();
  if (options.resume) {
    const resumed = await prepareResume(options, configSet, resumeFingerprint);
    results = resumed.results;
    matrixStartedAt = resumed.matrixStartedAt;
    console.log(`Resuming ${configSet.name}: keeping ${results.length} finished run(s); interrupted work will be replaced.`);
  }
  let activeRun = null;
  const writeMatrixSummary = async () => {
    if (!isMatrixRun) return;
    const expectedRuns = configSet.configurations.length * options.runs;
    const failedRuns = results.filter((item) => item.status === "failed").length;
    const interruptedRuns = results.filter((item) => item.status === "interrupted").length;
    const completedRuns = results.filter((item) => item.status === "completed").length;
    const summary = {
      schemaVersion: 1,
      configSet: configSet.name,
      configSetPath: configSet.sourcePath,
      targetContextWindowTokens: configSet.targetContextWindowTokens,
      resumeFingerprint,
      startedAt: matrixStartedAt,
      updatedAt: new Date().toISOString(),
      expectedRuns,
      completedRuns: results.length,
      successfulRuns: completedRuns,
      failedRuns,
      interruptedRuns,
      pendingRuns: Math.max(0, expectedRuns - results.length),
      activeRun,
      results,
    };
    await writeFile(path.join(options.runsDir, "matrix-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  };
  await writeMatrixSummary();
  runLoop: for (const configuration of configSet.configurations) {
    for (let run = 1; run <= options.runs; run++) {
      const previous = results.find((item) => item.configId === configuration.id && item.runIndex === run);
      if (previous && ["completed", "failed"].includes(previous.status)) {
        console.log(`Skipping ${configuration.id} run ${run}/${options.runs}: already ${previous.status}.`);
        continue;
      }
      if (requestedSignal) break runLoop;
      const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
      const runBaseName = `${stamp()}-${safeName(`${options.label ?? ""}-${configuration.id}`)}-run-${String(run).padStart(2, "0")}`;
      const runDir = path.join(options.runsDir, runBaseName);
      await mkdir(runDir, { recursive: false });
      await mkdir(options.projectsDir, { recursive: true });
      let projectDir = path.join(options.projectsDir, runBaseName);
      let projectSuffix = 1;
      while (true) {
        try {
          await mkdir(projectDir);
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          projectSuffix++;
          projectDir = path.join(options.projectsDir, `${runBaseName}-${projectSuffix}`);
        }
      }
      const startedAt = new Date().toISOString();
      const runStatePath = path.join(runDir, "run-state.json");
      const runState = {
        schemaVersion: 1,
        status: "running",
        configId: configuration.id,
        runIndex: run,
        runDir,
        projectDir,
        startedAt,
      };
      const runOptions = {
        ...options,
        runDir,
        projectDir,
        configId: configuration.id,
        configDescription: configuration.description,
        configSetName: configSet.name,
        targetContextWindowTokens: configSet.targetContextWindowTokens,
        configObject: configuration.config,
        config: configuration.configPath ?? options.config,
        configSourcePath: configuration.stockPi || configuration.billionContextPi ? null : configuration.configPath ?? (configuration.config ? `${configSet.sourcePath}#${configuration.id}` : options.config ? path.resolve(options.config) : path.join(ROOT, "examples", "baseline-config.json")),
        stockPi: configuration.stockPi === true,
        billionContextPi: configuration.billionContextPi === true,
        billionContextPiExtension: configuration.extensionPath ?? options.billionContextPiExtension ?? options.includeBillionContextPi,
        extension: configuration.billionContextPi ? null : options.extension,
        label: options.label ?? configuration.id,
      };
      await writeFile(runStatePath, `${JSON.stringify(runState, null, 2)}\n`);
      activeRun = { configId: configuration.id, runIndex: run, runDir, projectDir, startedAt };
      await writeMatrixSummary();
      let result;
      if (requestedSignal) {
        result = {
          schemaVersion: 1,
          configId: configuration.id,
          configDescription: configuration.description,
          configSet: configSet.name,
          runIndex: run,
          startedAt,
          finishedAt: new Date().toISOString(),
          projectDir,
          prompts: [],
          completion: { completedPrompts: 0, stuck: false, interrupted: true, failure: { message: `Benchmark interrupted by ${requestedSignal}`, code: "INTERRUPTED" } },
        };
        await writeFile(path.join(runDir, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
      } else {
        try {
          result = await runOne(runOptions, prompts, run);
        } catch (error) {
          const failedAt = new Date().toISOString();
          result = {
            schemaVersion: 1,
            label: runOptions.label,
            configId: configuration.id,
            configDescription: configuration.description,
            configSet: configSet.name,
            targetContextWindowTokens: configSet.targetContextWindowTokens,
            runIndex: run,
            startedAt: failedAt,
            finishedAt: failedAt,
            projectDir,
            sessionDir: path.join(runDir, "sessions"),
            sourceConfigPath: runOptions.configSourcePath,
            prompts: [],
            completion: { completedPrompts: 0, stuck: !requestedSignal, interrupted: Boolean(requestedSignal), failure: { message: requestedSignal ? `Benchmark interrupted by ${requestedSignal}` : error.message, code: requestedSignal ? "INTERRUPTED" : error.code ?? null } },
            artifacts: {
              bigPiLogFile: path.join(runDir, "big-pi.log"),
              bigPiRotatedLogFile: path.join(runDir, "big-pi.log.1"),
              bigPiContextDumpsDir: path.join(runDir, "big-pi-dumps"),
            },
          };
          await writeFile(path.join(runDir, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
          if (!requestedSignal) console.error(`Config ${configuration.id} failed before the Pi run: ${error.message}`);
        }
      }
      const status = requestedSignal || result.completion?.interrupted
        ? "interrupted"
        : result.completion?.failure || result.completion?.stuck || result.completion?.promptFailures?.length ? "failed" : "completed";
      const matrixResult = matrixResultFromRun(result, runOptions, run, status);
      results = results.filter((item) => !(item.configId === configuration.id && item.runIndex === run));
      results.push(matrixResult);
      activeRun = null;
      await writeMatrixSummary();
      runState.status = status;
      runState.finishedAt = new Date().toISOString();
      await writeFile(runStatePath, `${JSON.stringify(runState, null, 2)}\n`);
      if (status === "interrupted") break runLoop;
    }
  }
  if (requestedSignal) {
    await writeMatrixSummary();
    process.exitCode = requestedSignal === "SIGINT" ? 130 : 143;
    console.error(`Grid interrupted. Restart the same command with --resume to replace the partial run and continue.`);
    return;
  }
  if (isMatrixRun) {
    const successful = results.filter((item) => item.status === "completed").length;
    const failed = results.filter((item) => item.status === "failed").length;
    const pending = Math.max(0, configSet.configurations.length * options.runs - results.length);
    console.log(`Config set finished: ${successful}/${configSet.configurations.length * options.runs} successful; ${failed} failed; ${pending} not started; results index: ${path.join(options.runsDir, "matrix-summary.json")}`);
    if (failed) process.exitCode = 1;
  } else if (results.some((item) => item.status === "failed")) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? String(error));
  process.exitCode = 1;
});
