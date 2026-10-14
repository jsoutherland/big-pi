import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERSION = "0.1.0";
export const SCHEMA_VERSION = 1;
export const DEFAULTS = Object.freeze({
  growthTriggerTokens: 50000,
  nudge: Object.freeze({
    mode: "percentage",
    growthTriggerTokens: 50000,
    thresholdPercentage: 75,
    repeatEveryPercentage: 5,
    display: "used",
  }),
  emergency: Object.freeze({
    enabled: true,
    pressureThresholdPercentage: 85,
    targetPercentageAfterCompression: 70,
    maxAttemptsPerTurn: 2,
  }),
  hierarchy: Object.freeze({
    enabled: true,
    minBlocksPerPromotion: 3,
    tier2NudgeSummaryTokens: 20000,
    tier3NudgeSummaryTokens: 20000,
  }),
  minCompressRangeChars: 5000,
  minSummaryRetentionPercent: 2,
  protectedRecentMessages: 5,
  protectedRecentTokens: 5000,
  debug: false,
  contextDumpEnabled: true,
});

const LOG_MAX_BYTES = 1024 * 1024;
const PERCENTAGE_SCALE = 1_000_000;
const PERCENTAGE_REARM_HYSTERESIS = 1;
const LOG_PATH = process.env.BIG_PI_LOG_PATH
  ? path.resolve(process.env.BIG_PI_LOG_PATH)
  : path.join(os.homedir(), ".pi", "big-pi.log");
const ELIGIBLE_ROLES = new Set(["user", "assistant", "toolResult", "custom"]);

export class StateIntegrityError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "StateIntegrityError";
  }
}

export class ProjectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProjectionError";
  }
}

export function sidecarPath(sessionPath, agentId) {
  return path.join(storageFolderPath(sessionPath, agentId), "manifest.json");
}

function validateSessionFilePath(sessionPath) {
  if (typeof sessionPath !== "string" || !path.isAbsolute(sessionPath) || !sessionPath.endsWith(".jsonl")) {
    throw new TypeError("A Big Pi session path must be an absolute .jsonl file path");
  }
}

export function agentStorageRootPath(sessionPath) {
  validateSessionFilePath(sessionPath);
  return `${sessionPath}.big-pi-agents`;
}

export function agentStorageFolderPath(sessionPath, agentId) {
  validateSessionFilePath(sessionPath);
  if (typeof agentId !== "string" || !agentId.trim() || agentId.length > 512) {
    throw new TypeError("A Big Pi agent ID must be a non-empty string of at most 512 characters");
  }
  const key = createHash("sha256").update(agentId).digest("hex");
  return path.join(agentStorageRootPath(sessionPath), key);
}

export function storageFolderPath(sessionPath, agentId) {
  validateSessionFilePath(sessionPath);
  return agentId === undefined || agentId === null || agentId === ""
    ? `${sessionPath}.big-pi`
    : agentStorageFolderPath(sessionPath, agentId);
}

export function sessionDebugLogPath(sessionPath, agentId) {
  validateSessionFilePath(sessionPath);
  return agentId === undefined || agentId === null || agentId === ""
    ? `${sessionPath}.big-pi-debug.jsonl`
    : path.join(agentStorageFolderPath(sessionPath, agentId), "debug.jsonl");
}

export function deleteBigPiAgentData(sessionPath, agentId) {
  const directory = agentStorageFolderPath(sessionPath, agentId);
  const parent = agentStorageRootPath(sessionPath);
  try {
    const parentInfo = lstatSync(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new StateIntegrityError("Big Pi agent storage root must be a real directory");
    }
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  let info;
  try {
    info = lstatSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) rmSync(directory, { force: true });
  else rmSync(directory, { recursive: true, force: true });
  return true;
}

export function deleteAllBigPiAgentData(sessionPath) {
  const directory = agentStorageRootPath(sessionPath);
  try {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) rmSync(directory, { force: true });
    else rmSync(directory, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function appendSessionDebugEvent(sessionPath, event, details = {}, env = process.env, agentId) {
  if (!/^(?:1|true)$/i.test(String(env.BIG_PI_DEBUG ?? "").trim()) || typeof sessionPath !== "string" || !sessionPath) return;
  const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`;
  const logPath = sessionDebugLogPath(sessionPath, agentId);
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, line, { mode: 0o600 });
  } catch {
    // Debug diagnostics are best-effort and must never affect a Pi session.
  }
}

export function getConfigPath(env = process.env) {
  return env.BIG_PI_CONFIG || path.join(os.homedir(), ".pi", "big-pi.json");
}

function validPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function applyConfigValue(config, source, key, predicate, warning) {
  if (!Object.hasOwn(source, key)) return;
  if (!predicate(source[key])) {
    warning(`Invalid ${key}; using ${config[key]}`);
    return;
  }
  config[key] = source[key];
}

function validPercentage(value, allowZero = false) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= (allowZero ? 0 : Number.MIN_VALUE) &&
    value <= 100 &&
    Number.isSafeInteger(value * PERCENTAGE_SCALE);
}

function validCheckpointPercentage(value) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isSafeInteger(value * PERCENTAGE_SCALE);
}

function applyNudgeConfig(config, source, warning) {
  if (!Object.hasOwn(source, "nudge")) return;
  const nudge = source.nudge;
  if (!nudge || typeof nudge !== "object" || Array.isArray(nudge)) {
    warning("Invalid nudge; using default nudge settings");
    return;
  }
  if (Object.hasOwn(nudge, "mode")) {
    if (["growth", "percentage", "hybrid"].includes(nudge.mode)) config.nudge.mode = nudge.mode;
    else warning(`Invalid nudge.mode; using ${config.nudge.mode}`);
  }
  if (Object.hasOwn(nudge, "growthTriggerTokens")) {
    if (validPositiveInteger(nudge.growthTriggerTokens)) {
      config.nudge.growthTriggerTokens = nudge.growthTriggerTokens;
    } else {
      warning(`Invalid nudge.growthTriggerTokens; using ${config.nudge.growthTriggerTokens}`);
    }
  }
  if (Object.hasOwn(nudge, "thresholdPercentage")) {
    if (validPercentage(nudge.thresholdPercentage, true)) {
      config.nudge.thresholdPercentage = nudge.thresholdPercentage;
    } else {
      warning(`Invalid nudge.thresholdPercentage; using ${config.nudge.thresholdPercentage}`);
    }
  }
  if (Object.hasOwn(nudge, "repeatEveryPercentage")) {
    if (validPercentage(nudge.repeatEveryPercentage)) {
      config.nudge.repeatEveryPercentage = nudge.repeatEveryPercentage;
    } else {
      warning(`Invalid nudge.repeatEveryPercentage; using ${config.nudge.repeatEveryPercentage}`);
    }
  }
  if (Object.hasOwn(nudge, "display")) {
    if (["used", "remaining"].includes(nudge.display)) config.nudge.display = nudge.display;
    else warning(`Invalid nudge.display; using ${config.nudge.display}`);
  }
}

function applyEmergencyConfig(config, source, warning) {
  if (!Object.hasOwn(source, "emergency")) {
    if (Object.hasOwn(source, "emergencyContextUtilization")) {
      const legacy = source.emergencyContextUtilization;
      if (typeof legacy === "number" && Number.isFinite(legacy) && legacy > 0 && legacy <= 1) {
        config.emergency.pressureThresholdPercentage = legacy * 100;
      } else {
        warning("Invalid emergencyContextUtilization; using default emergency threshold");
      }
    }
    return;
  }
  const emergency = source.emergency;
  if (!emergency || typeof emergency !== "object" || Array.isArray(emergency)) {
    warning("Invalid emergency; using default emergency settings");
    return;
  }
  if (Object.hasOwn(emergency, "enabled")) {
    if (typeof emergency.enabled === "boolean") config.emergency.enabled = emergency.enabled;
    else warning(`Invalid emergency.enabled; using ${config.emergency.enabled}`);
  }
  if (Object.hasOwn(emergency, "pressureThresholdPercentage")) {
    if (validPercentage(emergency.pressureThresholdPercentage, true)) {
      config.emergency.pressureThresholdPercentage = emergency.pressureThresholdPercentage;
    } else {
      warning(`Invalid emergency.pressureThresholdPercentage; using ${config.emergency.pressureThresholdPercentage}`);
    }
  }
  if (Object.hasOwn(emergency, "targetPercentageAfterCompression")) {
    if (validPercentage(emergency.targetPercentageAfterCompression, true)) {
      config.emergency.targetPercentageAfterCompression = emergency.targetPercentageAfterCompression;
    } else {
      warning(`Invalid emergency.targetPercentageAfterCompression; using ${config.emergency.targetPercentageAfterCompression}`);
    }
  }
  if (Object.hasOwn(emergency, "maxAttemptsPerTurn")) {
    if (Number.isSafeInteger(emergency.maxAttemptsPerTurn) && emergency.maxAttemptsPerTurn >= 1 && emergency.maxAttemptsPerTurn <= 5) {
      config.emergency.maxAttemptsPerTurn = emergency.maxAttemptsPerTurn;
    } else {
      warning(`Invalid emergency.maxAttemptsPerTurn; using ${config.emergency.maxAttemptsPerTurn}`);
    }
  }
}

function applyHierarchyConfig(config, source, warning) {
  if (!Object.hasOwn(source, "hierarchy")) return;
  const hierarchy = source.hierarchy;
  if (!hierarchy || typeof hierarchy !== "object" || Array.isArray(hierarchy)) {
    warning("Invalid hierarchy; using default hierarchy settings");
    return;
  }
  if (Object.hasOwn(hierarchy, "enabled")) {
    if (typeof hierarchy.enabled === "boolean") config.hierarchy.enabled = hierarchy.enabled;
    else warning(`Invalid hierarchy.enabled; using ${config.hierarchy.enabled}`);
  }
  if (Object.hasOwn(hierarchy, "minBlocksPerPromotion")) {
    if (Number.isSafeInteger(hierarchy.minBlocksPerPromotion) && hierarchy.minBlocksPerPromotion >= 2) {
      config.hierarchy.minBlocksPerPromotion = hierarchy.minBlocksPerPromotion;
    } else warning(`Invalid hierarchy.minBlocksPerPromotion; using ${config.hierarchy.minBlocksPerPromotion}`);
  }
  for (const key of ["tier2NudgeSummaryTokens", "tier3NudgeSummaryTokens"]) {
    if (Object.hasOwn(hierarchy, key)) {
      if (Number.isSafeInteger(hierarchy[key]) && hierarchy[key] > 0) config.hierarchy[key] = hierarchy[key];
      else warning(`Invalid hierarchy.${key}; using ${config.hierarchy[key]}`);
    }
  }
}

function validateEmergencyConfig(config, warning) {
  if (config.emergency.targetPercentageAfterCompression < config.emergency.pressureThresholdPercentage) return;
  warning("Invalid emergency target; it must be lower than the pressure threshold, using default emergency percentages");
  config.emergency.pressureThresholdPercentage = DEFAULTS.emergency.pressureThresholdPercentage;
  config.emergency.targetPercentageAfterCompression = DEFAULTS.emergency.targetPercentageAfterCompression;
}

export function loadConfig(env = process.env, warn = () => {}) {
  const config = {
    ...DEFAULTS,
    nudge: { ...DEFAULTS.nudge },
    emergency: { ...DEFAULTS.emergency },
    hierarchy: { ...DEFAULTS.hierarchy },
  };
  const configPath = getConfigPath(env);
  let fileConfig = {};
  try {
    if (existsSync(configPath)) {
      fileConfig = JSON.parse(readFileSync(configPath, "utf8"));
      if (!fileConfig || typeof fileConfig !== "object" || Array.isArray(fileConfig)) {
        throw new Error("expected a JSON object");
      }
    }
  } catch (error) {
    warn(`Could not load config ${configPath}: ${error.message}; using defaults`);
    fileConfig = {};
  }

  applyConfigValue(config, fileConfig, "growthTriggerTokens", validPositiveInteger, warn);
  if (Object.hasOwn(fileConfig, "growthTriggerTokens")) {
    config.nudge.growthTriggerTokens = config.growthTriggerTokens;
  }
  applyNudgeConfig(config, fileConfig, warn);
  applyEmergencyConfig(config, fileConfig, warn);
  applyHierarchyConfig(config, fileConfig, warn);
  config.growthTriggerTokens = config.nudge.growthTriggerTokens;
  applyConfigValue(config, fileConfig, "minCompressRangeChars", validPositiveInteger, warn);
  applyConfigValue(config, fileConfig, "minSummaryRetentionPercent", (n) => validPercentage(n, true), warn);
  applyConfigValue(config, fileConfig, "protectedRecentMessages", (n) => Number.isSafeInteger(n) && n >= 0, warn);
  applyConfigValue(config, fileConfig, "protectedRecentTokens", (n) => Number.isSafeInteger(n) && n >= 0, warn);
  applyConfigValue(config, fileConfig, "debug", (value) => typeof value === "boolean", warn);
  applyConfigValue(config, fileConfig, "contextDumpEnabled", (value) => typeof value === "boolean", warn);

  if (env.BIG_PI_GROWTH_TRIGGER_TOKENS !== undefined) {
    const parsed = Number(env.BIG_PI_GROWTH_TRIGGER_TOKENS);
    if (validPositiveInteger(parsed)) {
      config.growthTriggerTokens = parsed;
      config.nudge.growthTriggerTokens = parsed;
    }
    else warn("Invalid BIG_PI_GROWTH_TRIGGER_TOKENS; using configured value");
  }
  if (env.BIG_PI_NUDGE_MODE !== undefined) {
    if (["growth", "percentage", "hybrid"].includes(env.BIG_PI_NUDGE_MODE)) {
      config.nudge.mode = env.BIG_PI_NUDGE_MODE;
    } else warn("Invalid BIG_PI_NUDGE_MODE; using configured value");
  }
  if (env.BIG_PI_NUDGE_THRESHOLD_PERCENTAGE !== undefined) {
    const parsed = Number(env.BIG_PI_NUDGE_THRESHOLD_PERCENTAGE);
    if (validPercentage(parsed, true)) config.nudge.thresholdPercentage = parsed;
    else warn("Invalid BIG_PI_NUDGE_THRESHOLD_PERCENTAGE; using configured value");
  }
  if (env.BIG_PI_NUDGE_REPEAT_PERCENTAGE !== undefined) {
    const parsed = Number(env.BIG_PI_NUDGE_REPEAT_PERCENTAGE);
    if (validPercentage(parsed)) config.nudge.repeatEveryPercentage = parsed;
    else warn("Invalid BIG_PI_NUDGE_REPEAT_PERCENTAGE; using configured value");
  }
  if (env.BIG_PI_NUDGE_DISPLAY !== undefined) {
    if (["used", "remaining"].includes(env.BIG_PI_NUDGE_DISPLAY)) {
      config.nudge.display = env.BIG_PI_NUDGE_DISPLAY;
    } else warn("Invalid BIG_PI_NUDGE_DISPLAY; using configured value");
  }
  if (env.BIG_PI_EMERGENCY_ENABLED !== undefined) {
    if (/^(true|1|yes)$/i.test(env.BIG_PI_EMERGENCY_ENABLED)) config.emergency.enabled = true;
    else if (/^(false|0|no)$/i.test(env.BIG_PI_EMERGENCY_ENABLED)) config.emergency.enabled = false;
    else warn("Invalid BIG_PI_EMERGENCY_ENABLED; using configured value");
  }
  for (const [key, envKey] of [
    ["pressureThresholdPercentage", "BIG_PI_PRESSURE_THRESHOLD_PERCENTAGE"],
    ["targetPercentageAfterCompression", "BIG_PI_TARGET_PERCENTAGE"],
  ]) {
    if (env[envKey] === undefined) continue;
    const parsed = Number(env[envKey]);
    if (validPercentage(parsed, true)) config.emergency[key] = parsed;
    else warn(`Invalid ${envKey}; using configured value`);
  }
  if (env.BIG_PI_MAX_EMERGENCY_ATTEMPTS !== undefined) {
    const parsed = Number(env.BIG_PI_MAX_EMERGENCY_ATTEMPTS);
    if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 5) config.emergency.maxAttemptsPerTurn = parsed;
    else warn("Invalid BIG_PI_MAX_EMERGENCY_ATTEMPTS; using configured value");
  }
  validateEmergencyConfig(config, warn);
  if (env.BIG_PI_MIN_COMPRESS_RANGE_CHARS !== undefined) {
    const parsed = Number(env.BIG_PI_MIN_COMPRESS_RANGE_CHARS);
    if (validPositiveInteger(parsed)) config.minCompressRangeChars = parsed;
    else warn("Invalid BIG_PI_MIN_COMPRESS_RANGE_CHARS; using configured value");
  }
  if (env.BIG_PI_MIN_SUMMARY_RETENTION_PERCENT !== undefined) {
    const parsed = Number(env.BIG_PI_MIN_SUMMARY_RETENTION_PERCENT);
    if (validPercentage(parsed, true)) config.minSummaryRetentionPercent = parsed;
    else warn("Invalid BIG_PI_MIN_SUMMARY_RETENTION_PERCENT; using configured value");
  }
  if (env.BIG_PI_DEBUG !== undefined) {
    if (/^(true|1|yes)$/i.test(env.BIG_PI_DEBUG.trim())) config.debug = true;
    else if (/^(false|0|no)$/i.test(env.BIG_PI_DEBUG.trim())) config.debug = false;
    else warn("Invalid BIG_PI_DEBUG; using configured value");
  }

  return { config, configPath };
}

export function createLogger({ debug = false, logPath } = {}) {
  const targetLogPath = logPath ?? (process.env.BIG_PI_LOG_PATH ? path.resolve(process.env.BIG_PI_LOG_PATH) : LOG_PATH);
  return (level, message) => {
    if (level === "debug" && !debug) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}\n`;
    try {
      mkdirSync(path.dirname(targetLogPath), { recursive: true });
      if (existsSync(targetLogPath) && statSync(targetLogPath).size + Buffer.byteLength(line) > LOG_MAX_BYTES) {
        const rotated = `${targetLogPath}.1`;
        try {
          renameSync(targetLogPath, rotated);
        } catch {
          // Logging must never affect session availability.
        }
      }
      writeFileSync(targetLogPath, line, { flag: "a", mode: 0o600 });
    } catch {
      // Logging is best-effort.
    }
  };
}

export function createEmptyState(sessionPathname, now = new Date().toISOString(), agentId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    producer: "big-pi",
    producerVersion: VERSION,
    session: {
      sessionPath: sessionPathname,
      ...(agentId ? { agentId } : {}),
      createdAt: now,
      updatedAt: now,
    },
    nextMessageNumber: 1,
    nextBlockNumber: 1,
    messageRefs: {},
    blocks: [],
    recovery: { damagedBlocks: [] },
    metrics: {
      projectedModelContextMessages: 0,
      projectedModelContextTokensEstimate: 0,
      projectedOriginalRawContextTokensEstimate: 0,
      compressionEligibleRawMessages: 0,
      compressionEligibleRawTokensEstimate: 0,
      activeRawMessages: 0,
      coveredSourceMessages: 0,
      sourceTokensRepresentedByApplicableBlocks: 0,
      applicableBlockDirectSourceTokensEstimate: 0,
      blockSummaryTokensEstimate: 0,
      effectiveTransformedContextTokensEstimate: 0,
      protectedMessageCount: 0,
      protectedTokenEstimate: 0,
      totalBlockCount: 0,
      activeBlockCount: 0,
      activeApplicableBlockCount: 0,
      hierarchy: [
        { tier: 1, activeBlockCount: 0, summaryTokensEstimate: 0 },
        { tier: 2, activeBlockCount: 0, summaryTokensEstimate: 0 },
        { tier: 3, activeBlockCount: 0, summaryTokensEstimate: 0 },
      ],
      tier2PromotionDue: false,
      tier3PromotionDue: false,
      tier2NudgeLatched: false,
      tier3NudgeLatched: false,
      staleBlockCount: 0,
      inapplicableBlockCount: 0,
      sourceMissingBlockCount: 0,
      sourceMismatchBlockCount: 0,
      nonContiguousBlockCount: 0,
      piContextUsageTokens: null,
      piContextWindow: null,
      currentUsedPercentage: null,
      currentRemainingPercentage: null,
      contextBudgetDeltaTokens: null,
      percentageStatus: "unavailable",
      percentageUnavailableReason: "current model context window unknown",
      percentageLastDeliveredCheckpoint: null,
      percentageNextCheckpoint: null,
      percentageLastNudgeAt: null,
      percentageNudgeDue: false,
      growthNudgeDue: false,
      normalGrowthSinceBaseline: 0,
      normalGrowthBaselineTokens: 0,
      growthSinceBaselineTokens: 0,
      growthBaselineEffectiveTokens: 0,
      nextNudgeAtGrowthTokens: DEFAULTS.growthTriggerTokens,
      nudgeDue: false,
      growthProjectionId: null,
      lastCompressionAt: null,
      lastCompressionResult: "none",
    },
    compression: {
      normalBaselineTokens: 0,
      growth: {
        growthTriggerTokens: DEFAULTS.growthTriggerTokens,
        projections: {},
      },
      percentage: {
        thresholdPercentage: DEFAULTS.nudge.thresholdPercentage,
        repeatEveryPercentage: DEFAULTS.nudge.repeatEveryPercentage,
        projections: {},
      },
      emergency: {
        projections: {},
      },
      hierarchy: {
        enabled: DEFAULTS.hierarchy.enabled,
        minBlocksPerPromotion: DEFAULTS.hierarchy.minBlocksPerPromotion,
        tier2NudgeSummaryTokens: DEFAULTS.hierarchy.tier2NudgeSummaryTokens,
        tier3NudgeSummaryTokens: DEFAULTS.hierarchy.tier3NudgeSummaryTokens,
        projections: {},
      },
    },
  };
}

export function calculateEmergencyPressure(effectiveTokens, contextWindow, emergencyConfig = DEFAULTS.emergency) {
  const denominatorAvailable = Number.isSafeInteger(contextWindow) && contextWindow > 0;
  const available = denominatorAvailable && Number.isSafeInteger(effectiveTokens) && effectiveTokens >= 0;
  const targetEffectiveTokens = denominatorAvailable
    ? Math.floor(contextWindow * emergencyConfig.targetPercentageAfterCompression / 100)
    : null;
  const usedPercentage = available ? effectiveTokens / contextWindow * 100 : null;
  return {
    usedPercentage,
    remainingPercentage: usedPercentage === null ? null : 100 - usedPercentage,
    overBudgetTokens: available ? Math.max(0, effectiveTokens - contextWindow) : null,
    targetEffectiveTokens,
    estimatedReclaimTokens: targetEffectiveTokens === null ? null : Math.max(0, effectiveTokens - targetEffectiveTokens),
    pressure: usedPercentage !== null && usedPercentage >= emergencyConfig.pressureThresholdPercentage,
  };
}

function chunkProvenanceError(entry, payload, messageRefs) {
  const refListIsValid = (refs) =>
    Array.isArray(refs) &&
    refs.length > 0 &&
    refs.every((ref) => typeof ref === "string" && /^M\d+$/.test(ref)) &&
    new Set(refs).size === refs.length;
  if (
    !payload ||
    typeof payload.summary !== "string" ||
    !payload.summary.trim() ||
    payload.summaryTokensEstimate !== estimateTokens(payload.summary) ||
    !Number.isSafeInteger(payload.sourceMessageCount) ||
    !Number.isSafeInteger(payload.sourceCharCount) ||
    payload.sourceCharCount < 1 ||
    !Number.isFinite(payload.sourceTokensEstimate) ||
    !Number.isSafeInteger(payload.originalSourceTokensEstimate) ||
    payload.originalSourceTokensEstimate < 0 ||
    payload.sourceTokensEstimate <= payload.summaryTokensEstimate ||
    !payload.sourceRefRange ||
    !refListIsValid(payload.effectiveOriginalMessageRefs) ||
    payload.sourceMessageCount !== payload.effectiveOriginalMessageRefs.length ||
    !Number.isSafeInteger(payload.sourceCharCount) ||
    !Number.isFinite(payload.sourceTokensEstimate) ||
    payload.sourceRefRange.start !== payload.effectiveOriginalMessageRefs[0] ||
    payload.sourceRefRange.end !== payload.effectiveOriginalMessageRefs.at(-1)
  ) return "chunk summary or source estimates are malformed";
  if (entry.tier === 1) {
    if (
      !refListIsValid(payload.sourceMessageRefs) ||
      JSON.stringify(payload.sourceMessageRefs) !== JSON.stringify(payload.effectiveOriginalMessageRefs) ||
      !Array.isArray(payload.sourceEntryIds) ||
      payload.sourceEntryIds.length !== payload.sourceMessageRefs.length ||
      payload.sourceEntryIds.some((entryId) => typeof entryId !== "string" || !entryId) ||
      new Set(payload.sourceEntryIds).size !== payload.sourceEntryIds.length ||
      !Array.isArray(payload.sourceProjectionEntryIds) ||
      payload.sourceProjectionEntryIds.length === 0 ||
      payload.sourceProjectionEntryIds.some((entryId) => typeof entryId !== "string" || !entryId) ||
      new Set(payload.sourceProjectionEntryIds).size !== payload.sourceProjectionEntryIds.length ||
      !Array.isArray(payload.sourceLineage) ||
      payload.sourceLineage.length !== payload.sourceMessageRefs.length ||
      payload.sourceMessageRefs.some((ref, index) => {
        const source = payload.sourceLineage[index];
        const reference = messageRefs?.[source?.entryId];
        return !source ||
          source.ref !== ref ||
          source.entryId !== payload.sourceEntryIds[index] ||
          reference?.id !== ref ||
          reference?.parentId !== source.parentId ||
          !(source.parentId === null || typeof source.parentId === "string") ||
          !/^[a-f0-9]{64}$/.test(source.fingerprint ?? "") ||
          !payload.sourceProjectionEntryIds.includes(source.entryId);
      }) ||
      payload.originalSourceTokensEstimate !== payload.sourceTokensEstimate
    ) return "Tier-1 chunk source provenance is invalid";
  } else if (
    payload.sourceMessageRefs?.length !== 0 ||
    payload.sourceEntryIds?.length !== 0 ||
    payload.sourceProjectionEntryIds?.length !== 0 ||
    payload.sourceLineage?.length !== 0 ||
    !Array.isArray(entry.sourceBlockIds) ||
    entry.sourceBlockIds.length < 2
  ) return "higher-tier chunk source provenance is invalid";
  return null;
}

export function readState(filePath, expectedSessionPath, expectedAgentId) {
  const folder = path.dirname(filePath);
  try {
    const folderInfo = lstatSync(folder);
    if (folderInfo.isSymbolicLink() || !folderInfo.isDirectory()) {
      throw new StateIntegrityError("Big-pi storage folder must be a real directory");
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      return { state: createEmptyState(expectedSessionPath, new Date().toISOString(), expectedAgentId), missing: true, recovery: [] };
    }
    if (error instanceof StateIntegrityError) throw error;
    throw new StateIntegrityError(`Cannot inspect big-pi storage: ${error.message}`, { cause: error });
  }
  if (!existsSync(filePath)) return { state: createEmptyState(expectedSessionPath, new Date().toISOString(), expectedAgentId), missing: true, recovery: [] };
  try {
    if (lstatSync(filePath).isSymbolicLink() || !lstatSync(filePath).isFile()) {
      throw new StateIntegrityError("Big-pi manifest must be a regular file, not a symlink");
    }
  } catch (error) {
    if (error instanceof StateIntegrityError) throw error;
    throw new StateIntegrityError(`Cannot inspect big-pi storage: ${error.message}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new StateIntegrityError(`Malformed big-pi manifest JSON: ${error.message}`, { cause: error });
    throw error;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.schemaVersion !== SCHEMA_VERSION ||
    parsed.producer !== "big-pi" ||
    parsed.session?.sessionPath !== expectedSessionPath ||
    parsed.session?.agentId !== expectedAgentId ||
    !Array.isArray(parsed.blocks) ||
    !parsed.recovery ||
    typeof parsed.recovery !== "object" ||
    !Array.isArray(parsed.recovery.damagedBlocks)
  ) {
    throw new StateIntegrityError("Unsupported or invalid big-pi manifest or session identity");
  }
  const recovery = [];
  const ids = new Set();
  const paths = new Set();
  parsed.blocks = parsed.blocks.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.blockId !== "string" ||
      !/^B\d+$/.test(entry.blockId) ||
      !Number.isSafeInteger(entry.tier) ||
      entry.tier < 1 ||
      entry.tier > 3 ||
      typeof entry.chunkPath !== "string" ||
      !/^blocks\/[A-Za-z0-9._-]+\.json$/.test(entry.chunkPath) ||
      entry.chunkPath.split("/").some((part) => part === "." || part === "..") ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "") ||
      ids.has(entry.blockId) ||
      paths.has(entry.chunkPath)
    ) {
      throw new StateIntegrityError("Manifest contains an invalid or duplicate committed chunk index entry");
    }
    ids.add(entry.blockId);
    paths.add(entry.chunkPath);
    const metadata = {
      id: entry.blockId,
      tier: entry.tier,
      sourceBlockIds: entry.sourceBlockIds,
      createdAt: entry.createdAt,
      status: entry.status,
      ...(entry.staleReason ? { staleReason: entry.staleReason } : {}),
      supersedesBlockIds: entry.supersedesBlockIds,
      supersededByBlockId: entry.supersededByBlockId,
      _storageIndex: structuredClone(entry),
    };
    let payload;
    let chunkError;
    try {
      const chunkDirectory = path.join(folder, "blocks");
      const chunkPath = path.resolve(folder, ...entry.chunkPath.split("/"));
      if (!chunkPath.startsWith(`${path.resolve(folder)}${path.sep}`)) {
        throw new Error("chunk path escapes the storage folder");
      }
      if (lstatSync(folder).isSymbolicLink()) throw new Error("storage folder is a symlink");
      if (lstatSync(chunkDirectory).isSymbolicLink() || !lstatSync(chunkDirectory).isDirectory()) {
        throw new Error("chunk directory is missing or is not a real directory");
      }
      const chunkInfo = lstatSync(chunkPath);
      if (chunkInfo.isSymbolicLink()) throw new Error("chunk path is a symlink and will not be followed");
      if (!chunkInfo.isFile()) throw new Error("chunk is missing or is not a regular file");
      const contents = readFileSync(chunkPath);
      if (createHash("sha256").update(contents).digest("hex") !== entry.sha256) {
        throw new Error("chunk checksum does not match its committed manifest entry");
      }
      const chunk = JSON.parse(contents.toString("utf8"));
      if (
        chunk?.schemaVersion !== 1 ||
        chunk.blockId !== entry.blockId ||
        !chunk.provenance ||
        typeof chunk.provenance !== "object" ||
        Array.isArray(chunk.provenance)
      ) {
        throw new Error("chunk schema, block ID, or provenance is invalid");
      }
      payload = { ...chunk.provenance, summary: chunk.summary, summaryTokensEstimate: chunk.summaryTokensEstimate };
      if (
        typeof payload.summary !== "string" ||
        !payload.summary.trim() ||
        payload.summaryTokensEstimate !== estimateTokens(payload.summary) ||
        !Array.isArray(payload.sourceMessageRefs) ||
        !Array.isArray(payload.effectiveOriginalMessageRefs) ||
        !Array.isArray(payload.sourceEntryIds) ||
        !Array.isArray(payload.sourceProjectionEntryIds) ||
        !Array.isArray(payload.sourceLineage) ||
        !payload.sourceRefRange ||
        !Number.isSafeInteger(payload.sourceMessageCount) ||
        !Number.isSafeInteger(payload.sourceCharCount) ||
        !Number.isFinite(payload.sourceTokensEstimate) ||
        !Number.isSafeInteger(payload.originalSourceTokensEstimate)
      ) throw new Error("chunk summary integrity validation failed");
      if (entry.tier === 1 && (
        payload.sourceMessageRefs.length === 0 ||
        payload.sourceLineage.length !== payload.sourceMessageRefs.length ||
        payload.sourceMessageRefs.length !== payload.effectiveOriginalMessageRefs.length ||
        payload.sourceMessageRefs.some((ref, index) =>
          ref !== payload.effectiveOriginalMessageRefs[index] ||
          payload.sourceLineage[index]?.ref !== ref ||
          payload.sourceLineage[index]?.entryId !== payload.sourceEntryIds[index] ||
          !/^[a-f0-9]{64}$/.test(payload.sourceLineage[index]?.fingerprint ?? "")
        )
      )) throw new Error("Tier-1 chunk provenance is invalid");
      if (entry.tier > 1 && (
        payload.sourceMessageRefs.length !== 0 ||
        payload.sourceLineage.length !== 0 ||
        !Array.isArray(entry.sourceBlockIds) ||
        entry.sourceBlockIds.length < 2 ||
        payload.effectiveOriginalMessageRefs.length === 0
      )) throw new Error("Higher-tier chunk provenance is invalid");
      if (payload.sourceRefRange.start !== payload.effectiveOriginalMessageRefs[0] ||
          payload.sourceRefRange.end !== payload.effectiveOriginalMessageRefs.at(-1)) {
        throw new Error("chunk source range does not match its provenance");
      }
      const provenanceError = chunkProvenanceError(entry, payload, parsed.messageRefs);
      if (provenanceError) throw new Error(provenanceError);
    } catch (error) {
      chunkError = error.message;
      recovery.push({ blockId: entry.blockId, chunkPath: entry.chunkPath, reason: chunkError });
    }
    return {
      ...metadata,
      ...(payload ?? {
        sourceMessageRefs: [],
        effectiveOriginalMessageRefs: [],
        sourceEntryIds: [],
        sourceProjectionEntryIds: [],
        sourceLineage: [],
        sourceRefRange: { start: "", end: "" },
        sourceMessageCount: 0,
        sourceCharCount: 0,
        sourceTokensEstimate: 0,
        originalSourceTokensEstimate: 0,
        summary: "",
        summaryTokensEstimate: 0,
      }),
      ...(chunkError ? { storageError: chunkError } : {}),
    };
  });
  parsed.recovery = { damagedBlocks: recovery.map(({ blockId }) => blockId) };
  const markDamaged = (block, reason) => {
    if (block.storageError) return;
    block.storageError = reason;
    recovery.push({ blockId: block.id, chunkPath: block._storageIndex.chunkPath, reason });
    parsed.recovery.damagedBlocks.push(block.id);
  };
  const tier1Claims = new Map();
  for (const block of parsed.blocks) {
    if (block.storageError || block.tier !== 1 || block.status !== "active" || block.supersededByBlockId !== null) continue;
    for (const ref of block.sourceMessageRefs) {
      const key = `${JSON.stringify(block.sourceProjectionEntryIds)}\0${ref}`;
      if (tier1Claims.has(key)) {
        markDamaged(block, `overlapping Tier-1 provenance conflicts with committed block ${tier1Claims.get(key)}`);
        break;
      }
      tier1Claims.set(key, block.id);
    }
  }
  const hydratedBlocksById = new Map(parsed.blocks.map((block) => [block.id, block]));
  for (const block of parsed.blocks) {
    if (block.storageError || block.tier === 1) continue;
    const children = block.sourceBlockIds.map((id) => hydratedBlocksById.get(id));
    if (children.some((child) => !child || child.storageError)) continue;
    const childRefs = children.flatMap((child) => child.effectiveOriginalMessageRefs);
    const childSummaryTokens = children.reduce((sum, child) => sum + child.summaryTokensEstimate, 0);
    const childOriginalTokens = children.reduce((sum, child) => sum + child.originalSourceTokensEstimate, 0);
    if (
      JSON.stringify(childRefs) !== JSON.stringify(block.effectiveOriginalMessageRefs) ||
      childSummaryTokens !== block.sourceTokensEstimate ||
      childOriginalTokens !== block.originalSourceTokensEstimate
    ) {
      markDamaged(block, "higher-tier chunk provenance does not match its committed descendants");
    }
  }
  if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new StateIntegrityError(`Unsupported or invalid manifest schema (expected ${SCHEMA_VERSION})`);
  }
  if (
    parsed.producer !== "big-pi" ||
    !Array.isArray(parsed.blocks) ||
    !parsed.messageRefs ||
    typeof parsed.messageRefs !== "object" ||
    Array.isArray(parsed.messageRefs) ||
    !parsed.metrics ||
    typeof parsed.metrics !== "object" ||
    Array.isArray(parsed.metrics) ||
    !parsed.compression ||
    typeof parsed.compression !== "object" ||
    Array.isArray(parsed.compression) ||
    !parsed.compression.growth ||
    typeof parsed.compression.growth !== "object" ||
    Array.isArray(parsed.compression.growth) ||
    !validPositiveInteger(parsed.compression.growth.growthTriggerTokens) ||
    !parsed.compression.growth.projections ||
    typeof parsed.compression.growth.projections !== "object" ||
    Array.isArray(parsed.compression.growth.projections) ||
    !parsed.compression.percentage ||
    typeof parsed.compression.percentage !== "object" ||
    Array.isArray(parsed.compression.percentage) ||
    !validPercentage(parsed.compression.percentage.thresholdPercentage, true) ||
    !validPercentage(parsed.compression.percentage.repeatEveryPercentage) ||
    !parsed.compression.percentage.projections ||
    typeof parsed.compression.percentage.projections !== "object" ||
    Array.isArray(parsed.compression.percentage.projections) ||
    !parsed.compression.emergency ||
    typeof parsed.compression.emergency !== "object" ||
    Array.isArray(parsed.compression.emergency) ||
    !parsed.compression.emergency.projections ||
    typeof parsed.compression.emergency.projections !== "object" ||
    Array.isArray(parsed.compression.emergency.projections) ||
    !parsed.compression.hierarchy ||
    typeof parsed.compression.hierarchy !== "object" ||
    Array.isArray(parsed.compression.hierarchy) ||
    typeof parsed.compression.hierarchy.enabled !== "boolean" ||
    !Number.isSafeInteger(parsed.compression.hierarchy.minBlocksPerPromotion) ||
    parsed.compression.hierarchy.minBlocksPerPromotion < 2 ||
    !validPositiveInteger(parsed.compression.hierarchy.tier2NudgeSummaryTokens) ||
    !validPositiveInteger(parsed.compression.hierarchy.tier3NudgeSummaryTokens) ||
    !parsed.compression.hierarchy.projections ||
    typeof parsed.compression.hierarchy.projections !== "object" ||
    Array.isArray(parsed.compression.hierarchy.projections) ||
    !Number.isSafeInteger(parsed.nextMessageNumber) ||
    parsed.nextMessageNumber < 1 ||
    !Number.isSafeInteger(parsed.nextBlockNumber) ||
    parsed.nextBlockNumber < 1
  ) {
    throw new StateIntegrityError("Manifest is missing required big-pi fields");
  }
  if (parsed.session?.sessionPath !== expectedSessionPath || parsed.session?.agentId !== expectedAgentId) {
    throw new StateIntegrityError("Manifest session path or agent ID does not match this Pi context");
  }
  let maxMessageNumber = 0;
  const referenceIds = new Set();
  for (const [entryId, reference] of Object.entries(parsed.messageRefs)) {
    const match = /^M(\d+)$/.exec(reference?.id ?? "");
    if (
      !entryId ||
      !match ||
      reference.entryId !== entryId ||
      referenceIds.has(reference.id) ||
      !/^[a-f0-9]{64}$/.test(reference.signature ?? "") ||
      typeof reference.role !== "string" ||
      !(reference.parentId === null || typeof reference.parentId === "string")
    ) {
      throw new StateIntegrityError("Manifest contains malformed stable message references");
    }
    referenceIds.add(reference.id);
    maxMessageNumber = Math.max(maxMessageNumber, Number(match[1]));
  }
  if (parsed.nextMessageNumber <= maxMessageNumber) {
    throw new StateIntegrityError("Manifest message-reference counter could reuse an existing ID");
  }
  const refs = new Map();
  const blockIds = new Set();
  let maxBlockNumber = 0;
  for (const block of parsed.blocks) {
    if (block.storageError) {
      if (
        !block ||
        typeof block.id !== "string" ||
        !/^B\d+$/.test(block.id) ||
        !Number.isSafeInteger(block.tier) ||
        block.tier < 1 ||
        block.tier > 3 ||
        !["active", "stale"].includes(block.status) ||
        !Array.isArray(block.sourceBlockIds) ||
        block.sourceBlockIds.some((id) => typeof id !== "string" || !/^B\d+$/.test(id)) ||
        new Set(block.sourceBlockIds).size !== block.sourceBlockIds.length ||
        (block.tier === 1 && block.sourceBlockIds.length !== 0) ||
        (block.tier > 1 && block.sourceBlockIds.length < 2) ||
        !Array.isArray(block.supersedesBlockIds) ||
        block.supersedesBlockIds.some((id) => typeof id !== "string" || !/^B\d+$/.test(id)) ||
        new Set(block.supersedesBlockIds).size !== block.supersedesBlockIds.length ||
        !(block.supersededByBlockId === null ||
          (typeof block.supersededByBlockId === "string" && /^B\d+$/.test(block.supersededByBlockId))) ||
        (block.status === "stale" && (typeof block.staleReason !== "string" || !block.staleReason))
      ) {
        throw new StateIntegrityError("Manifest contains malformed metadata for a damaged committed chunk");
      }
      if (blockIds.has(block.id)) throw new StateIntegrityError(`Manifest contains duplicate block ID ${block.id}`);
      blockIds.add(block.id);
      maxBlockNumber = Math.max(maxBlockNumber, Number(block.id.slice(1)));
      continue;
    }
    if (
      !block ||
      typeof block.id !== "string" ||
      !/^B\d+$/.test(block.id) ||
      !Number.isSafeInteger(block.tier) ||
      block.tier < 1 ||
      block.tier > 3 ||
      !Array.isArray(block.sourceMessageRefs) ||
      (block.tier === 1 ? block.sourceMessageRefs.length === 0 : block.sourceMessageRefs.length !== 0) ||
      block.sourceMessageRefs.some((ref) => typeof ref !== "string" || !/^M\d+$/.test(ref)) ||
      new Set(block.sourceMessageRefs).size !== block.sourceMessageRefs.length ||
      typeof block.summary !== "string" ||
      !block.summary.trim() ||
      !block.sourceRefRange ||
      typeof block.sourceRefRange.start !== "string" ||
      typeof block.sourceRefRange.end !== "string" ||
      block.sourceRefRange.start !== block.effectiveOriginalMessageRefs?.[0] ||
      block.sourceRefRange.end !== block.effectiveOriginalMessageRefs?.at(-1) ||
      !Number.isFinite(block.sourceTokensEstimate) ||
      !Number.isSafeInteger(block.originalSourceTokensEstimate) ||
      block.originalSourceTokensEstimate < 0 ||
      !Number.isFinite(block.summaryTokensEstimate) ||
      block.summaryTokensEstimate !== estimateTokens(block.summary) ||
      block.sourceTokensEstimate <= block.summaryTokensEstimate ||
      block.sourceMessageCount !== block.effectiveOriginalMessageRefs?.length ||
      !Number.isSafeInteger(block.sourceCharCount) ||
      block.sourceCharCount < 1 ||
      !Array.isArray(block.sourceBlockIds) ||
      !Array.isArray(block.effectiveOriginalMessageRefs) ||
      block.effectiveOriginalMessageRefs.length === 0 ||
      block.effectiveOriginalMessageRefs.some((ref) => typeof ref !== "string" || !/^M\d+$/.test(ref)) ||
      new Set(block.effectiveOriginalMessageRefs).size !== block.effectiveOriginalMessageRefs.length ||
      !Array.isArray(block.sourceEntryIds) ||
      block.sourceEntryIds.length !== (block.tier === 1 ? block.sourceMessageRefs.length : 0) ||
      new Set(block.sourceEntryIds).size !== block.sourceEntryIds.length ||
      !Array.isArray(block.sourceProjectionEntryIds) ||
      (block.tier === 1 && block.sourceProjectionEntryIds.length === 0) ||
      block.sourceProjectionEntryIds.some((entryId) => typeof entryId !== "string" || !entryId) ||
      new Set(block.sourceProjectionEntryIds).size !== block.sourceProjectionEntryIds.length ||
      block.sourceEntryIds.some((entryId) => !block.sourceProjectionEntryIds.includes(entryId)) ||
      !Array.isArray(block.sourceLineage) ||
      block.sourceLineage.length !== (block.tier === 1 ? block.sourceMessageRefs.length : 0) ||
      block.sourceLineage.some((source, index) =>
        !source ||
        source.ref !== block.sourceMessageRefs[index] ||
        source.entryId !== block.sourceEntryIds[index] ||
        parsed.messageRefs[source.entryId]?.id !== source.ref ||
        parsed.messageRefs[source.entryId]?.parentId !== source.parentId ||
        typeof source.entryId !== "string" ||
        !/^[a-f0-9]{64}$/.test(source.fingerprint) ||
        !(source.parentId === null || typeof source.parentId === "string")
      ) ||
      !["active", "stale"].includes(block.status) ||
      !Array.isArray(block.supersedesBlockIds) ||
      block.supersedesBlockIds.some((id) => typeof id !== "string" || !/^B\d+$/.test(id)) ||
      new Set(block.supersedesBlockIds).size !== block.supersedesBlockIds.length ||
      !(block.supersededByBlockId === null || (typeof block.supersededByBlockId === "string" && /^B\d+$/.test(block.supersededByBlockId))) ||
      (block.tier === 1 && block.sourceBlockIds.length !== 0) ||
      (block.tier > 1 && (block.sourceBlockIds.length < 2 || block.sourceBlockIds.some((id) => typeof id !== "string" || !/^B\d+$/.test(id)))) ||
      (block.status === "stale" && (typeof block.staleReason !== "string" || !block.staleReason))
    ) {
      throw new StateIntegrityError("Manifest contains malformed compression block/provenance metadata");
    }
    if (blockIds.has(block.id)) throw new StateIntegrityError(`Manifest contains duplicate block ID ${block.id}`);
    blockIds.add(block.id);
    maxBlockNumber = Math.max(maxBlockNumber, Number(block.id.slice(1)));
    if (block.status === "active" && block.tier === 1 && block.supersededByBlockId === null) {
      for (const ref of block.sourceMessageRefs) {
        const previousBlocks = refs.get(ref) ?? [];
        if (previousBlocks.some((previous) =>
          JSON.stringify(previous.sourceProjectionEntryIds) === JSON.stringify(block.sourceProjectionEntryIds)
        )) throw new StateIntegrityError(`Manifest contains overlapping active source refs in one projection: ${ref}`);
        previousBlocks.push(block);
        refs.set(ref, previousBlocks);
      }
    }
  }
  const blocksById = new Map(parsed.blocks.map((block) => [block.id, block]));
  const parentClaims = new Map();
  for (const block of parsed.blocks) {
    if (block.supersededByBlockId !== null) {
      const parent = blocksById.get(block.supersededByBlockId);
      if (!parent || !parent.supersedesBlockIds.includes(block.id) || parent.tier !== block.tier + 1) {
        throw new StateIntegrityError(`Manifest contains invalid supersession parent for ${block.id}`);
      }
    }
    for (const childId of block.sourceBlockIds) {
      const child = blocksById.get(childId);
      if (!child || child.tier !== block.tier - 1 || child.supersededByBlockId !== block.id) {
        throw new StateIntegrityError(`Manifest contains invalid hierarchy child ${childId} for ${block.id}`);
      }
      const previousParent = parentClaims.get(childId);
      if (previousParent && previousParent !== block.id) {
        throw new StateIntegrityError(`Manifest contains overlapping active parents for ${childId}`);
      }
      parentClaims.set(childId, block.id);
    }
    if (block.tier > 1 && !block.storageError && block.sourceBlockIds.every((id) => !blocksById.get(id)?.storageError)) {
      const children = block.sourceBlockIds.map((id) => blocksById.get(id));
      const originals = children.flatMap((child) => child.effectiveOriginalMessageRefs);
      if (
        new Set(originals).size !== originals.length ||
        JSON.stringify(originals) !== JSON.stringify(block.effectiveOriginalMessageRefs)
      ) throw new StateIntegrityError(`Manifest contains invalid transitive lineage for ${block.id}`);
      const tokenMass = children.reduce((total, child) => total + child.summaryTokensEstimate, 0);
      if (block.sourceTokensEstimate !== tokenMass) {
        throw new StateIntegrityError(`Manifest contains invalid source summary estimate for ${block.id}`);
      }
      const originalTokenMass = children.reduce((total, child) => total + child.originalSourceTokensEstimate, 0);
      if (block.originalSourceTokensEstimate !== originalTokenMass) {
        throw new StateIntegrityError(`Manifest contains invalid original source estimate for ${block.id}`);
      }
    } else if (block.tier === 1 && !block.storageError &&
      JSON.stringify(block.sourceMessageRefs) !== JSON.stringify(block.effectiveOriginalMessageRefs)) {
      throw new StateIntegrityError(`Tier-1 block ${block.id} has inconsistent original-message lineage`);
    } else if (block.tier === 1 && !block.storageError &&
      block.originalSourceTokensEstimate !== block.sourceTokensEstimate) {
      throw new StateIntegrityError(`Tier-1 block ${block.id} has inconsistent original source estimate`);
    }
  }
  for (const block of parsed.blocks) {
    const visited = new Set([block.id]);
    let parentId = block.supersededByBlockId;
    while (parentId !== null) {
      if (visited.has(parentId)) throw new StateIntegrityError(`Manifest hierarchy contains a cycle at ${block.id}`);
      visited.add(parentId);
      parentId = blocksById.get(parentId)?.supersededByBlockId ?? null;
    }
  }
  if (parsed.nextBlockNumber <= maxBlockNumber) {
    throw new StateIntegrityError("Manifest block counter could reuse an existing ID");
  }
  for (const [projectionId, cadence] of Object.entries(parsed.compression.hierarchy.projections)) {
    if (
      !/^[a-f0-9]{64}$/.test(projectionId) ||
      !cadence ||
      typeof cadence !== "object" ||
      typeof cadence.tier2NudgeLatched !== "boolean" ||
      typeof cadence.tier3NudgeLatched !== "boolean" ||
      !(cadence.lastNudgeAt === null || typeof cadence.lastNudgeAt === "string")
    ) throw new StateIntegrityError("Manifest contains malformed hierarchy nudge cadence state");
  }
  for (const [projectionId, cadence] of Object.entries(parsed.compression.growth.projections)) {
    if (
      !/^[a-f0-9]{64}$/.test(projectionId) ||
      !cadence ||
      typeof cadence !== "object" ||
      !Number.isSafeInteger(cadence.baselineEffectiveTokens) ||
      cadence.baselineEffectiveTokens < 0 ||
      !(cadence.cadenceNudgeGrowthTokens === null ||
        (Number.isSafeInteger(cadence.cadenceNudgeGrowthTokens) && cadence.cadenceNudgeGrowthTokens >= 0)) ||
      !(cadence.lastNudgeGrowthTokens === null ||
        (Number.isSafeInteger(cadence.lastNudgeGrowthTokens) && cadence.lastNudgeGrowthTokens >= 0)) ||
      !(cadence.lastNudgeAt === null || typeof cadence.lastNudgeAt === "string") ||
      !(cadence.lastSuccessfulCompressionAt === null || typeof cadence.lastSuccessfulCompressionAt === "string") ||
      !(cadence.lastSuccessfulCompressionEffectiveTokens === null ||
        (Number.isSafeInteger(cadence.lastSuccessfulCompressionEffectiveTokens) &&
          cadence.lastSuccessfulCompressionEffectiveTokens >= 0)) ||
      !(cadence.branchAnchorEntryId === null || typeof cadence.branchAnchorEntryId === "string")
    ) {
      throw new StateIntegrityError("Manifest contains malformed growth/nudge cadence state");
    }
  }
  for (const [projectionId, cadence] of Object.entries(parsed.compression.percentage.projections)) {
    if (
      !/^[a-f0-9]{64}$/.test(projectionId) ||
      !cadence ||
      typeof cadence !== "object" ||
      !(cadence.lastDeliveredCheckpointPercentage === null ||
        validCheckpointPercentage(cadence.lastDeliveredCheckpointPercentage)) ||
      !validCheckpointPercentage(cadence.nextCheckpointPercentage) ||
      typeof cadence.rearmedAfterDrop !== "boolean" ||
      !(cadence.lastNudgeAt === null || typeof cadence.lastNudgeAt === "string")
    ) {
      throw new StateIntegrityError("Manifest contains malformed percentage nudge cadence state");
    }
  }
  for (const [projectionId, emergency] of Object.entries(parsed.compression.emergency.projections)) {
    if (
      !/^[a-f0-9]{64}$/.test(projectionId) ||
      !emergency ||
      typeof emergency !== "object" ||
      !(emergency.lastPressureAt === null || typeof emergency.lastPressureAt === "string") ||
      !(emergency.lastOverflowAt === null || typeof emergency.lastOverflowAt === "string") ||
      !(emergency.lastOverflowReason === null || typeof emergency.lastOverflowReason === "string") ||
      ![
        "none",
        "requested",
        "partial",
        "recovered",
        "fallback-pending",
        "fallback-completed",
        "fallback-failed",
        "failed",
        "interrupted",
      ].includes(emergency.lastOutcome) ||
      !["none", "pending", "completed", "failed"].includes(emergency.nativeFallbackState) ||
      !["none", "pressure", "overflow"].includes(emergency.activeEpisode) ||
      !(emergency.lastEstimatedReclaimTokens === null ||
        (Number.isSafeInteger(emergency.lastEstimatedReclaimTokens) && emergency.lastEstimatedReclaimTokens >= 0)) ||
      !(emergency.lastReason === null || typeof emergency.lastReason === "string")
    ) {
      throw new StateIntegrityError("Manifest contains malformed emergency diagnostics");
    }
  }
  return { state: parsed, missing: false, recovery };
}

export function writeStateAtomic(filePath, state) {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(state, null, 2)}\n`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (existsSync(temporary)) {
        unlinkSync(temporary);
      }
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
}

export function estimateTokens(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(Buffer.byteLength(serialized, "utf8") / 3);
}

// Anchor the current projection estimate to the provider's last completed
// prompt count, then carry forward only the estimated change since that prompt.
// This preserves real usage as the ruler while allowing for messages added or
// removed (including Big Pi compression) after the measured request.
export function calibrateContextEstimate(currentEstimate, providerPromptTokens, estimateAtMeasuredRequest) {
  if (!Number.isSafeInteger(currentEstimate) || currentEstimate < 0 ||
      !Number.isSafeInteger(providerPromptTokens) || providerPromptTokens < 0 ||
      !Number.isSafeInteger(estimateAtMeasuredRequest) || estimateAtMeasuredRequest < 0) {
    return currentEstimate;
  }
  return Math.max(0, providerPromptTokens + currentEstimate - estimateAtMeasuredRequest);
}

export function parseProviderContextWindow(text) {
  if (typeof text !== "string" || !/context|prompt|token|input/i.test(text)) return null;
  const patterns = [
    /prompt is too long[^\n]*?>\s*([\d,]+)\s*(?:tokens?)?\s*maximum/i,
    /maximum context length is\s*([\d,]+)/i,
    /maximum context size (?:is|of)\s*([\d,]+)/i,
    /(?:maximum|limit) of\s*([\d,]+)\s*(?:input\s+)?tokens/i,
    /context window.{0,40}?(\d[\d,]+)\s*tokens/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number(match[1].replace(/,/g, ""));
    if (Number.isSafeInteger(value) && value >= 1000) return value;
  }
  return null;
}

export function minimumSummaryTokens(sourceTokensEstimate, retentionPercent = DEFAULTS.minSummaryRetentionPercent) {
  if (retentionPercent === 0) return 0;
  return Math.max(64, Math.ceil(sourceTokensEstimate * retentionPercent / 100));
}

export function validateSummaryRetention(summary, sourceTokensEstimate, retentionPercent = DEFAULTS.minSummaryRetentionPercent) {
  if (retentionPercent === 0) return;
  const summaryTokensEstimate = estimateTokens(summary);
  const requiredTokens = minimumSummaryTokens(sourceTokensEstimate, retentionPercent);
  if (summaryTokensEstimate < requiredTokens) {
    const actualPercent = sourceTokensEstimate > 0
      ? (summaryTokensEstimate / sourceTokensEstimate) * 100
      : 0;
    throw new Error(
      `Summary is too short for the selected source (${summaryTokensEstimate} estimated tokens, ${actualPercent.toFixed(2)}% retained; minimum ${requiredTokens} tokens at ${retentionPercent}%). Write a fuller evidence-preserving summary or choose smaller logical ranges.`,
    );
  }
}

export function growthProjectionId(identity) {
  return createHash("sha256").update(String(identity)).digest("hex");
}

export function ensureGrowthCadence(state, projection, effectiveTokens, growthTriggerTokens) {
  const growth = state.compression.growth;
  growth.growthTriggerTokens = growthTriggerTokens;
  let cadence = growth.projections[projection.id];
  let initialized = false;
  let resetAfterDecrease = false;
  if (!cadence) {
    cadence = {
      branchAnchorEntryId: projection.branchAnchorEntryId ?? null,
      baselineEffectiveTokens: effectiveTokens,
      cadenceNudgeGrowthTokens: null,
      lastNudgeAt: null,
      lastNudgeGrowthTokens: null,
      lastSuccessfulCompressionAt: null,
      lastSuccessfulCompressionEffectiveTokens: null,
    };
    growth.projections[projection.id] = cadence;
    initialized = true;
  } else if (effectiveTokens < cadence.baselineEffectiveTokens) {
    cadence.branchAnchorEntryId = projection.branchAnchorEntryId ?? null;
    cadence.baselineEffectiveTokens = effectiveTokens;
    cadence.cadenceNudgeGrowthTokens = null;
    resetAfterDecrease = true;
  }
  const growthSinceBaselineTokens = Math.max(0, effectiveTokens - cadence.baselineEffectiveTokens);
  const nextNudgeAtGrowthTokens =
    (cadence.cadenceNudgeGrowthTokens ?? 0) + growthTriggerTokens;
  state.compression.normalBaselineTokens = cadence.baselineEffectiveTokens;
  return {
    cadence,
    initialized,
    resetAfterDecrease,
    growthSinceBaselineTokens,
    nextNudgeAtGrowthTokens,
    nudgeDue: growthSinceBaselineTokens >= nextNudgeAtGrowthTokens,
  };
}

export function recordGrowthNudge(state, projectionId, growthTokens, at = new Date().toISOString()) {
  const cadence = state.compression.growth.projections[projectionId];
  if (!cadence) throw new Error("Cannot record a nudge without an initialized projection baseline");
  cadence.cadenceNudgeGrowthTokens = growthTokens;
  cadence.lastNudgeGrowthTokens = growthTokens;
  cadence.lastNudgeAt = at;
}

export function advanceGrowthBaseline(state, projectionId, effectiveTokens, at = new Date().toISOString()) {
  const cadence = state.compression.growth.projections[projectionId];
  if (!cadence) throw new Error("Cannot advance a baseline without an initialized projection");
  cadence.baselineEffectiveTokens = effectiveTokens;
  cadence.cadenceNudgeGrowthTokens = null;
  cadence.lastSuccessfulCompressionAt = at;
  cadence.lastSuccessfulCompressionEffectiveTokens = effectiveTokens;
  state.compression.normalBaselineTokens = effectiveTokens;
}

function percentageMicros(value) {
  return Math.round(value * PERCENTAGE_SCALE);
}

function usedAtLeastCheckpoint(effectiveTokens, contextWindow, checkpointPercentage) {
  return BigInt(effectiveTokens) * 100n * BigInt(PERCENTAGE_SCALE) >=
    BigInt(contextWindow) * BigInt(percentageMicros(checkpointPercentage));
}

function checkpointAtOrBelowUsage(effectiveTokens, contextWindow, thresholdPercentage, repeatEveryPercentage) {
  const threshold = BigInt(percentageMicros(thresholdPercentage));
  const repeat = BigInt(percentageMicros(repeatEveryPercentage));
  const usedNumerator = BigInt(effectiveTokens) * 100n * BigInt(PERCENTAGE_SCALE);
  const thresholdNumerator = BigInt(contextWindow) * threshold;
  if (usedNumerator < thresholdNumerator) return null;
  const index = (usedNumerator - thresholdNumerator) / (BigInt(contextWindow) * repeat);
  return Number(threshold + index * repeat) / PERCENTAGE_SCALE;
}

function firstCheckpointAboveUsage(effectiveTokens, contextWindow, thresholdPercentage, repeatEveryPercentage) {
  const highest = checkpointAtOrBelowUsage(
    effectiveTokens,
    contextWindow,
    thresholdPercentage,
    repeatEveryPercentage,
  );
  return highest === null ? thresholdPercentage : highest + repeatEveryPercentage;
}

export function ensurePercentageCadence(
  state,
  projectionId,
  effectiveTokens,
  contextWindow,
  thresholdPercentage,
  repeatEveryPercentage,
) {
  const percentage = state.compression.percentage;
  percentage.thresholdPercentage = thresholdPercentage;
  percentage.repeatEveryPercentage = repeatEveryPercentage;
  let cadence = percentage.projections[projectionId];
  const available = Number.isSafeInteger(contextWindow) && contextWindow > 0 &&
    Number.isSafeInteger(effectiveTokens) && effectiveTokens >= 0;
  if (!cadence) {
    cadence = {
      lastDeliveredCheckpointPercentage: null,
      nextCheckpointPercentage: thresholdPercentage,
      rearmedAfterDrop: false,
      lastNudgeAt: null,
      thresholdPercentage,
      repeatEveryPercentage,
    };
    percentage.projections[projectionId] = cadence;
  }

  const currentUsedPercentage = available ? (effectiveTokens / contextWindow) * 100 : null;
  const currentRemainingPercentage = available ? 100 - currentUsedPercentage : null;
  const contextBudgetDeltaTokens = available ? contextWindow - effectiveTokens : null;
  let rearmed = false;
  if (available && (
    cadence.thresholdPercentage !== thresholdPercentage ||
    cadence.repeatEveryPercentage !== repeatEveryPercentage
  )) {
    cadence.thresholdPercentage = thresholdPercentage;
    cadence.repeatEveryPercentage = repeatEveryPercentage;
    cadence.nextCheckpointPercentage = firstCheckpointAboveUsage(
      effectiveTokens,
      contextWindow,
      thresholdPercentage,
      repeatEveryPercentage,
    );
    cadence.rearmedAfterDrop = true;
    rearmed = true;
  } else if (
    available &&
    !cadence.rearmedAfterDrop &&
    cadence.lastDeliveredCheckpointPercentage !== null &&
    BigInt(effectiveTokens) * 100n * BigInt(PERCENTAGE_SCALE) <
      BigInt(contextWindow) *
        BigInt(percentageMicros(cadence.lastDeliveredCheckpointPercentage - PERCENTAGE_REARM_HYSTERESIS))
  ) {
    cadence.nextCheckpointPercentage = firstCheckpointAboveUsage(
      effectiveTokens,
      contextWindow,
      thresholdPercentage,
      repeatEveryPercentage,
    );
    cadence.rearmedAfterDrop = true;
    rearmed = true;
  }
  const percentageNudgeDue = available &&
    usedAtLeastCheckpoint(effectiveTokens, contextWindow, cadence.nextCheckpointPercentage);
  const dueCheckpointPercentage = percentageNudgeDue
    ? cadence.nextCheckpointPercentage
    : null;
  return {
    cadence,
    available,
    currentUsedPercentage,
    currentRemainingPercentage,
    contextBudgetDeltaTokens,
    percentageNudgeDue,
    dueCheckpointPercentage,
    nextCheckpointPercentage: cadence.nextCheckpointPercentage,
    rearmed,
  };
}

export function recordPercentageNudge(state, projectionId, checkpointPercentage, at = new Date().toISOString()) {
  const cadence = state.compression.percentage.projections[projectionId];
  if (!cadence) throw new Error("Cannot record a percentage nudge without initialized projection state");
  cadence.lastDeliveredCheckpointPercentage = checkpointPercentage;
  cadence.nextCheckpointPercentage = checkpointPercentage + cadence.repeatEveryPercentage;
  cadence.lastNudgeAt = at;
  cadence.rearmedAfterDrop = false;
}

export function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return JSON.stringify(message?.content ?? "");
  return message.content
    .map((part) => (part?.type === "text" ? part.text : JSON.stringify(part)))
    .join("\n");
}

export function messageSignature(message) {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}

export function isCompressibleMessage(message) {
  return ELIGIBLE_ROLES.has(message?.role);
}

export function ensureMessageReferences(state, projection) {
  const bindings = [];
  const projectionEntryIds = (projection?.entries ?? [])
    .map((projectedEntry) => projectedEntry.sourceEntry?.id)
    .filter((entryId) => typeof entryId === "string");
  let contextIndex = 0;
  for (const projectedEntry of projection?.entries ?? []) {
    const entry = projectedEntry.sourceEntry;
    if (!Array.isArray(projectedEntry.messages)) continue;
    for (const message of projectedEntry.messages) {
      if (
        (entry?.type === "message" || entry?.type === "custom_message") &&
        isCompressibleMessage(message)
      ) {
        if (typeof entry?.id !== "string" || !entry.id) {
          throw new ProjectionError("A projected message has no stable Pi session-entry ID");
        }
        let reference = state.messageRefs[entry.id];
        if (!reference) {
          reference = {
            id: `M${String(state.nextMessageNumber++).padStart(6, "0")}`,
            entryId: entry.id,
            signature: messageSignature(message),
            role: message.role,
            timestamp: entry.timestamp,
            parentId: typeof entry.parentId === "string" ? entry.parentId : null,
          };
          state.messageRefs[entry.id] = reference;
        } else if (reference.parentId !== (typeof entry.parentId === "string" ? entry.parentId : null)) {
          throw new StateIntegrityError(`Pi session-entry ancestry changed for ${entry.id}`);
        }
        bindings.push({
          ref: reference.id,
          entryId: entry.id,
          parentId: typeof entry.parentId === "string" ? entry.parentId : null,
          projectionEntryIds,
          message,
          signature: messageSignature(message),
          contextIndex,
        });
      }
      contextIndex++;
    }
  }
  return bindings;
}

export function bindContextMessages(messages, bindings) {
  const result = [];
  let bindingIndex = 0;
  for (const message of messages) {
    if (!isCompressibleMessage(message)) {
      result.push(null);
      continue;
    }
    const binding = bindings[bindingIndex];
    if (!binding || binding.signature !== messageSignature(message) || binding.message.role !== message.role) {
      throw new ProjectionError("Context messages no longer match the current Pi projection in order");
    }
    result.push(binding);
    bindingIndex++;
  }
  if (bindingIndex !== bindings.length) {
    throw new ProjectionError("Context messages are missing sources from the current Pi projection");
  }
  return result;
}

function toolExchangeGroups(messages) {
  const groups = new Map();
  const malformedPositions = new Set();
  const groupFor = (id) => {
    let group = groups.get(id);
    if (!group) {
      group = { calls: [], results: [] };
      groups.set(id, group);
    }
    return group;
  };
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "toolCall") continue;
        if (typeof part.id !== "string" || !part.id) malformedPositions.add(index);
        else groupFor(part.id).calls.push(index);
      }
    } else if (message?.role === "toolResult") {
      if (typeof message.toolCallId === "string" && message.toolCallId) {
        groupFor(message.toolCallId).results.push(index);
      }
    }
  }
  return { groups, malformedPositions };
}

function toolExchangeSelectionError(messages, selectedPositions) {
  const { groups, malformedPositions } = toolExchangeGroups(messages);
  if ([...malformedPositions].some((position) => selectedPositions.has(position))) {
    return "Selected source contains a tool call/result without a valid tool-call ID";
  }
  for (const [id, group] of groups) {
    const positions = new Set([...group.calls, ...group.results]);
    if (![...positions].some((position) => selectedPositions.has(position))) continue;
    if (group.calls.length !== 1 || group.results.length !== 1) {
      return `Selected source contains incomplete or ambiguous tool exchange ${id}`;
    }
    if ([...positions].some((position) => !selectedPositions.has(position))) {
      return `Selected source splits tool call ${id} from its matching result`;
    }
  }
  return null;
}

export function toolExchangeBlockedRefs(messages, bindings, unavailableRefs = new Set()) {
  const refForMessage = bindContextMessages(messages, bindings);
  const blockedRefs = new Set();
  const blockPositions = (positions) => {
    let changed = false;
    for (const position of positions) {
      const ref = refForMessage[position]?.ref;
      if (ref && !blockedRefs.has(ref)) {
        blockedRefs.add(ref);
        changed = true;
      }
    }
    return changed;
  };
  const { groups, malformedPositions } = toolExchangeGroups(messages);
  blockPositions(malformedPositions);
  let changed;
  do {
    changed = false;
    for (const group of groups.values()) {
      const endpoints = [...new Set([...group.calls, ...group.results])];
      if (group.calls.length !== 1 || group.results.length !== 1) {
        changed = blockPositions(endpoints) || changed;
        continue;
      }
      const first = Math.min(...endpoints);
      const last = Math.max(...endpoints);
      const span = Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
      if (span.some((position) => {
        const ref = refForMessage[position]?.ref;
        return !ref || unavailableRefs.has(ref) || blockedRefs.has(ref);
      })) {
        changed = blockPositions(endpoints) || changed;
      }
    }
  } while (changed);
  return blockedRefs;
}

function assertToolExchangeTransformation(beforeMessages, afterMessages) {
  const before = toolExchangeGroups(beforeMessages);
  const after = toolExchangeGroups(afterMessages);
  const ids = new Set([...before.groups.keys(), ...after.groups.keys()]);
  for (const id of ids) {
    const beforeGroup = before.groups.get(id) ?? { calls: [], results: [] };
    const afterGroup = after.groups.get(id) ?? { calls: [], results: [] };
    const removedCalls = beforeGroup.calls.length - afterGroup.calls.length;
    const removedResults = beforeGroup.results.length - afterGroup.results.length;
    if (removedCalls !== removedResults || removedCalls < 0 || removedResults < 0) {
      throw new ProjectionError(`Context transformation would split tool call ${id} from its matching result`);
    }
  }
  if (before.malformedPositions.size !== after.malformedPositions.size) {
    throw new ProjectionError("Context transformation would remove a tool call/result without a valid tool-call ID");
  }
}

export function computeProtectedRefs(bindings, config) {
  if (!bindings.length) return { refs: new Set(), tokens: 0 };
  const protectedRefs = new Set();
  const firstUser = bindings.find((binding) => binding.message.role === "user");
  if (firstUser) protectedRefs.add(firstUser.ref);
  const latestUser = [...bindings].reverse().find((binding) => binding.message.role === "user");
  if (latestUser) protectedRefs.add(latestUser.ref);

  const recentCount = Math.min(config.protectedRecentMessages, bindings.length);
  if (recentCount > 0) {
    for (const binding of bindings.slice(-recentCount)) protectedRefs.add(binding.ref);
  }

  let tokens = 0;
  for (let index = bindings.length - 1; index >= 0 && tokens < config.protectedRecentTokens; index--) {
    const binding = bindings[index];
    protectedRefs.add(binding.ref);
    tokens += estimateTokens(binding.message);
  }
  return { refs: protectedRefs, tokens };
}

export function validateSelectedRange(
  bindings,
  protectedRefs,
  blocks,
  startRef,
  endRef,
  minCompressRangeChars = DEFAULTS.minCompressRangeChars,
  projectedMessages = bindings.map((binding) => binding.message),
) {
  const start = bindings.findIndex((binding) => binding.ref === startRef);
  const end = bindings.findIndex((binding) => binding.ref === endRef);
  if (start < 0 || end < start) throw new Error("Model selected an unknown or reversed source range");
  const selected = bindings.slice(start, end + 1);
  if (!selected.length || selected.some((binding) => protectedRefs.has(binding.ref))) {
    throw new Error("Model selected protected or empty context");
  }
  for (let index = 1; index < selected.length; index++) {
    if (
      Number.isSafeInteger(selected[index - 1].contextIndex) &&
      selected[index].contextIndex !== selected[index - 1].contextIndex + 1
    ) {
      throw new Error("Model selected a non-contiguous source range");
    }
  }
  const alreadyCovered = applicableCoveredRefs(bindings, blocks, protectedRefs, projectedMessages);
  if (selected.some((binding) => alreadyCovered.has(binding.ref))) {
    throw new Error("Model selected source refs already covered by an active block");
  }
  const selectedPositions = new Set(selected.map((binding) => binding.contextIndex));
  const toolExchangeError = toolExchangeSelectionError(projectedMessages, selectedPositions);
  if (toolExchangeError) throw new Error(toolExchangeError);
  const sourceChars = selected.reduce((total, binding) => total + messageText(binding.message).length, 0);
  if (sourceChars < minCompressRangeChars) {
    throw new Error(`Selected range is below the ${minCompressRangeChars}-character minimum`);
  }
  return selected;
}

export function createBlock(state, selected, summary, now = new Date().toISOString()) {
  if (!Array.isArray(selected) || selected.length === 0 || typeof summary !== "string" || !summary.trim()) {
    throw new Error("A block requires source messages and a non-empty summary");
  }
  const sourceTokensEstimate = selected.reduce((total, item) => total + estimateTokens(item.message), 0);
  const summaryTokensEstimate = estimateTokens(summary);
  if (summaryTokensEstimate >= sourceTokensEstimate) {
    throw new Error("Summary must be smaller than its source range to reduce context");
  }
  const block = {
    id: `B${String(state.nextBlockNumber++).padStart(6, "0")}`,
    tier: 1,
    sourceMessageRefs: selected.map((item) => item.ref),
    sourceBlockIds: [],
    effectiveOriginalMessageRefs: selected.map((item) => item.ref),
    sourceEntryIds: selected.map((item) => item.entryId),
    sourceProjectionEntryIds: [...(selected[0].projectionEntryIds ?? selected.map((item) => item.entryId))],
    sourceLineage: selected.map((item) => ({
      ref: item.ref,
      entryId: item.entryId,
      parentId: item.parentId ?? null,
      fingerprint: item.signature,
    })),
    sourceCharCount: selected.reduce((total, item) => total + messageText(item.message).length, 0),
    sourceRefRange: { start: selected[0].ref, end: selected.at(-1).ref },
    sourceMessageCount: selected.length,
    sourceTokensEstimate,
    originalSourceTokensEstimate: sourceTokensEstimate,
    summary,
    summaryTokensEstimate,
    createdAt: now,
    status: "active",
    supersedesBlockIds: [],
    supersededByBlockId: null,
  };
  state.blocks.push(block);
  state.metrics.lastCompressionAt = now;
  state.metrics.lastCompressionResult = `created ${block.id}`;
  return block;
}

export function applyCompression(
  state,
  bindings,
  protectedRefs,
  startRef,
  endRef,
  summary,
  minCompressRangeChars,
  projectedMessages = bindings.map((binding) => binding.message),
  minSummaryRetentionPercent = 0,
) {
  const selected = validateSelectedRange(
    bindings,
    protectedRefs,
    state.blocks,
    startRef,
    endRef,
    minCompressRangeChars,
    projectedMessages,
  );
  const sourceTokensEstimate = selected.reduce((total, item) => total + estimateTokens(item.message), 0);
  validateSummaryRetention(summary, sourceTokensEstimate, minSummaryRetentionPercent);
  const originalBlockCount = state.blocks.length;
  const originalNextBlockNumber = state.nextBlockNumber;
  const originalMetrics = structuredClone(state.metrics);
  const beforeEffectiveTokens = estimateTokens(transformContext(
    projectedMessages,
    bindings,
    state.blocks,
    protectedRefs,
  ));
  try {
    const block = createBlock(state, selected, summary);
    const afterEffectiveTokens = estimateTokens(transformContext(
      projectedMessages,
      bindings,
      state.blocks,
      protectedRefs,
    ));
    if (afterEffectiveTokens >= beforeEffectiveTokens) {
      throw new Error("Summary does not reduce estimated effective context after the block header and wrapper");
    }
    return block;
  } catch (error) {
    state.blocks.length = originalBlockCount;
    state.nextBlockNumber = originalNextBlockNumber;
    state.metrics = originalMetrics;
    throw error;
  }
}

export function getDirectChildren(block, blocks) {
  const byId = new Map(blocks.map((item) => [item.id, item]));
  return (block?.sourceBlockIds ?? []).map((id) => byId.get(id)).filter(Boolean);
}

export function getEffectiveOriginalRefs(block) {
  return [...(block?.effectiveOriginalMessageRefs ?? block?.sourceMessageRefs ?? [])];
}

export function isBlockSuperseded(block) {
  return block?.supersededByBlockId !== null && block?.supersededByBlockId !== undefined;
}

export function createHierarchicalBlock(
  state,
  bindings,
  sourceBlockIds,
  summary,
  hierarchyConfig = DEFAULTS.hierarchy,
  minSourceChars = DEFAULTS.minCompressRangeChars,
  protectedRefs = new Set(),
  projectedMessages = bindings.map((binding) => binding.message),
  minSummaryRetentionPercent = 0,
) {
  if (!hierarchyConfig.enabled) throw new Error("Hierarchical compression is disabled by configuration");
  if (!Array.isArray(sourceBlockIds) || sourceBlockIds.length < Math.max(2, hierarchyConfig.minBlocksPerPromotion)) {
    throw new Error(`Promotion requires at least ${Math.max(2, hierarchyConfig.minBlocksPerPromotion)} source blocks`);
  }
  if (new Set(sourceBlockIds).size !== sourceBlockIds.length) throw new Error("Promotion source block IDs must be unique");
  if (typeof summary !== "string" || !summary.trim()) throw new Error("A higher-tier block requires a non-empty summary");
  const byId = new Map(state.blocks.map((block) => [block.id, block]));
  const children = sourceBlockIds.map((id) => {
    const block = byId.get(id);
    if (!block) throw new Error(`Unknown source block ID ${id}`);
    return block;
  });
  const sourceTier = children[0].tier;
  if (sourceTier !== 1 && sourceTier !== 2) throw new Error("Tier-3 is the highest supported tier; it cannot be promoted");
  if (children.some((block) => block.tier !== sourceTier)) throw new Error("Promotion cannot mix source tiers");
  if (children.some((block) => block.status !== "active")) throw new Error("All source blocks must have active lifecycle");
  if (children.some(isBlockSuperseded)) throw new Error("A source block is already superseded by another block");
  const currentApplicability = getBlockApplicability(projectedMessages, bindings, state.blocks, protectedRefs);
  if (children.some((block) => !currentApplicability.applicableBlockIds.has(block.id))) {
    throw new Error("All source blocks must be applicable and active in the current projection");
  }
  const positionsByRef = new Map(bindings.map((binding) => [binding.ref, binding.contextIndex]));
  const refs = children.flatMap(getEffectiveOriginalRefs);
  if (new Set(refs).size !== refs.length) throw new Error("Promotion source blocks overlap in original-message lineage");
  const positions = refs.map((ref) => positionsByRef.get(ref));
  if (positions.some((position) => position === undefined)) throw new Error("A source block is inapplicable on the current projection");
  if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) {
    throw new Error("Promotion source blocks are reversed or non-contiguous in the current projection");
  }
  const sourceCharCount = children.reduce((total, block) => total + block.summary.length, 0);
  if (sourceCharCount < minSourceChars) {
    throw new Error(`Promotion source summaries are below the ${minSourceChars}-character minimum`);
  }
  const sourceTokensEstimate = children.reduce((total, block) => total + block.summaryTokensEstimate, 0);
  const summaryTokensEstimate = estimateTokens(summary);
  validateSummaryRetention(summary, sourceTokensEstimate, minSummaryRetentionPercent);
  if (summaryTokensEstimate >= sourceTokensEstimate) {
    throw new Error("Higher-tier summary must be smaller than its source summaries to reduce context");
  }
  const beforeEffectiveTokens = estimateTokens(transformContext(
    projectedMessages,
    bindings,
    state.blocks,
    protectedRefs,
  ));
  const originalBlockCount = state.blocks.length;
  const originalNextBlockNumber = state.nextBlockNumber;
  const originalMetrics = structuredClone(state.metrics);
  const id = `B${String(state.nextBlockNumber++).padStart(6, "0")}`;
  const block = {
    id,
    tier: sourceTier + 1,
    sourceMessageRefs: [],
    sourceBlockIds: [...sourceBlockIds],
    effectiveOriginalMessageRefs: refs,
    sourceEntryIds: [],
    sourceProjectionEntryIds: [],
    sourceLineage: [],
    sourceCharCount,
    sourceRefRange: { start: refs[0], end: refs.at(-1) },
    sourceMessageCount: refs.length,
    sourceTokensEstimate,
    originalSourceTokensEstimate: children.reduce((total, block) => total + block.originalSourceTokensEstimate, 0),
    summary,
    summaryTokensEstimate,
    createdAt: new Date().toISOString(),
    status: "active",
    supersedesBlockIds: [...sourceBlockIds],
    supersededByBlockId: null,
  };
  try {
    for (const child of children) child.supersededByBlockId = id;
    state.blocks.push(block);
    const afterEffectiveTokens = estimateTokens(transformContext(
      projectedMessages,
      bindings,
      state.blocks,
      protectedRefs,
    ));
    if (afterEffectiveTokens >= beforeEffectiveTokens) {
      throw new Error("Higher-tier summary does not reduce estimated effective context");
    }
  } catch (error) {
    state.blocks.length = originalBlockCount;
    for (const child of children) child.supersededByBlockId = null;
    state.nextBlockNumber = originalNextBlockNumber;
    state.metrics = originalMetrics;
    throw error;
  }
  state.metrics.lastCompressionAt = block.createdAt;
  state.metrics.lastCompressionResult = `created ${block.id}`;
  return block;
}

export function applicableCoveredRefs(
  bindings,
  blocks,
  protectedRefs = new Set(),
  messages = bindings.map((binding) => binding.message),
) {
  const applicability = getBlockApplicability(messages, bindings, blocks, protectedRefs);
  return new Set([...applicability.applicableBlockIds].flatMap((id) => {
    const block = blocks.find((item) => item.id === id);
    return getEffectiveOriginalRefs(block);
  }));
}

export function transformContext(messages, bindings, blocks, protectedRefs = new Set()) {
  const { blockStarts, coveredIndices } = locateActiveBlocks(messages, bindings, blocks, protectedRefs);
  const output = [];
  for (let index = 0; index < messages.length; index++) {
    const block = blockStarts.get(index);
    if (block) {
      output.push({
        role: "user",
        content: [{
          type: "text",
          text: `[big-pi compressed context ${block.id}; source refs ${block.sourceRefRange.start}..${block.sourceRefRange.end}]\n${block.summary}`,
        }],
      });
      index += getEffectiveOriginalRefs(block).length - 1;
    } else if (!coveredIndices.has(index)) {
      output.push(messages[index]);
    }
  }
  assertToolExchangeTransformation(messages, output);
  return output;
}

export function renderContextDump(messages, bindings, blocks, protectedRefs = new Set(), storage = {}) {
  const { blockStarts, coveredIndices, refForMessage } = locateActiveBlocks(messages, bindings, blocks, protectedRefs);
  const lines = [
    "big-pi logical context dump (may contain sensitive session content)",
    ...(storage.manifestPath ? [`Manifest: ${storage.manifestPath}`] : []),
    ...(Number.isSafeInteger(storage.committedChunkCount)
      ? [`Committed chunks: ${storage.committedChunkCount}`]
      : []),
    ...(Number.isSafeInteger(storage.diskUsageBytes) ? [`Storage disk usage: ${storage.diskUsageBytes} bytes`] : []),
    ...(storage.damagedBlocks?.length
      ? [`Damaged committed chunks: ${storage.damagedBlocks.map(({ blockId, reason }) => `${blockId}: ${reason}`).join("; ")}`]
      : []),
  ];
  for (let index = 0; index < messages.length; index++) {
    const ref = refForMessage[index]?.ref;
    const block = blockStarts.get(index);
    if (block) {
      lines.push(`===== BIG-PI BLOCK ${block.id} =====`);
      lines.push(block.summary);
      index += getEffectiveOriginalRefs(block).length - 1;
      continue;
    }
    if (coveredIndices.has(index)) continue;
    lines.push(`===== RAW ${ref ?? "UNLINKED"} ${String(messages[index].role ?? "UNKNOWN").toUpperCase()} =====`);
    lines.push(JSON.stringify(messages[index], null, 2));
  }
  return `${lines.join("\n")}\n`;
}

export function getBlockApplicability(messages, bindings, blocks, protectedRefs = new Set()) {
  const { blockStarts, skippedBlockReasons } = locateActiveBlocks(messages, bindings, blocks, protectedRefs);
  return {
    applicableBlockIds: new Set([...blockStarts.values()].map((block) => block.id)),
    skippedBlockReasons,
  };
}

function locateActiveBlocks(messages, bindings, blocks, protectedRefs = new Set()) {
  const refForMessage = bindContextMessages(messages, bindings);
  const positionsByRef = new Map();
  for (let index = 0; index < refForMessage.length; index++) {
    const ref = refForMessage[index]?.ref;
    if (!ref) continue;
    const positions = positionsByRef.get(ref) ?? [];
    positions.push(index);
    positionsByRef.set(ref, positions);
  }
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const evaluation = new Map();
  const evaluate = (block, visiting = new Set()) => {
    if (evaluation.has(block.id)) return evaluation.get(block.id);
    if (visiting.has(block.id)) return { applicable: false, reason: "hierarchy cycle detected" };
    if (block.storageError) {
      const result = { applicable: false, reason: `committed chunk is damaged: ${block.storageError}` };
      evaluation.set(block.id, result);
      return result;
    }
    if (block.status !== "active") {
      const result = { applicable: false, reason: `block lifecycle is ${block.status}` };
      evaluation.set(block.id, result);
      return result;
    }
    const nextVisiting = new Set(visiting).add(block.id);
    if (block.tier > 1) {
      const children = getDirectChildren(block, blocks);
      if (children.length !== block.sourceBlockIds.length || children.some((child) => !evaluate(child, nextVisiting).applicable)) {
        const result = { applicable: false, reason: "descendant source mismatch" };
        evaluation.set(block.id, result);
        return result;
      }
    }
    const refs = getEffectiveOriginalRefs(block);
    if (refs.some((ref) => protectedRefs.has(ref))) {
      const result = { applicable: false, reason: "source range intersects current protected context" };
      evaluation.set(block.id, result);
      return result;
    }
    const positions = refs.map((ref) => {
      const found = positionsByRef.get(ref);
      return found?.length === 1 ? found[0] : null;
    });
    if (positions.some((position) => position === null)) {
      const result = { applicable: false, reason: "source entries are absent from this projection" };
      evaluation.set(block.id, result);
      return result;
    }
    if (block.tier === 1) {
      const currentSources = positions.map((position) => refForMessage[position]);
      if (block.sourceLineage.some((source, index) => currentSources[index]?.signature !== source.fingerprint)) {
        const result = { applicable: false, reason: "source content differs in this projection" };
        evaluation.set(block.id, result);
        return result;
      }
    } else {
      const childrenRefs = block.sourceBlockIds.flatMap((id) => getEffectiveOriginalRefs(blocksById.get(id)));
      if (JSON.stringify(childrenRefs) !== JSON.stringify(refs)) {
        const result = { applicable: false, reason: "descendant lineage differs" };
        evaluation.set(block.id, result);
        return result;
      }
    }
    if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) {
      const result = { applicable: false, reason: "source entries are not contiguous in this projection" };
      evaluation.set(block.id, result);
      return result;
    }
    const toolExchangeError = toolExchangeSelectionError(messages, new Set(positions));
    if (toolExchangeError) {
      const result = { applicable: false, reason: toolExchangeError };
      evaluation.set(block.id, result);
      return result;
    }
    const result = { applicable: true, positions };
    evaluation.set(block.id, result);
    return result;
  };

  const skippedBlockReasons = new Map();
  const candidates = blocks
    .filter((block) => block.status === "active")
    .map((block) => ({ block, result: evaluate(block) }))
    .filter(({ block, result }) => {
      if (!result.applicable) skippedBlockReasons.set(block.id, result.reason);
      return result.applicable;
    })
    .sort((left, right) =>
      right.block.tier - left.block.tier ||
      left.result.positions[0] - right.result.positions[0] ||
      left.block.id.localeCompare(right.block.id)
    );
  const blockStarts = new Map();
  const coveredIndices = new Set();
  for (const { block, result } of candidates) {
    if (result.positions.some((position) => coveredIndices.has(position))) {
      const parentId = block.supersededByBlockId;
      skippedBlockReasons.set(block.id, parentId ? `superseded by applicable ${parentId}` : "overlaps another applicable representation");
      continue;
    }
    blockStarts.set(result.positions[0], block);
    for (const position of result.positions) coveredIndices.add(position);
  }
  return { refForMessage, blockStarts, coveredIndices, skippedBlockReasons };
}

export function updateMetrics(
  state,
  bindings,
  protectedRefs,
  projectedMessages = bindings.map((binding) => binding.message),
  transformedMessages = projectedMessages,
  contextUsage,
  growthProjection = {},
  nudgeConfig = DEFAULTS.nudge,
  usableContextWindow = null,
  percentageUnavailableReason = "current model context window unknown",
  effectiveTokensOverride = null,
  measuredContextTokensOverride = null,
) {
  const activeBlocks = state.blocks.filter((block) => block.status === "active");
  const applicability = getBlockApplicability(projectedMessages, bindings, state.blocks, protectedRefs);
  const applicableBlockIds = applicability.applicableBlockIds;
  const applicableBlocks = activeBlocks.filter((block) => applicableBlockIds.has(block.id));
  const covered = new Set(applicableBlocks.flatMap(getEffectiveOriginalRefs));
  const rawTokens = estimateTokens(projectedMessages);
  const protectedBindings = bindings.filter((binding) => protectedRefs.has(binding.ref));
  const unsafeToolRefs = toolExchangeBlockedRefs(
    projectedMessages,
    bindings,
    new Set([...protectedRefs, ...covered]),
  );
  const compressionEligible = bindings.filter((binding) =>
    !protectedRefs.has(binding.ref) && !covered.has(binding.ref) && !unsafeToolRefs.has(binding.ref)
  );
  const summaryTokens = applicableBlocks.reduce((total, block) => total + block.summaryTokensEstimate, 0);
  const previousLastCompressionAt = state.metrics.lastCompressionAt ?? null;
  const previousLastCompressionResult = state.metrics.lastCompressionResult ?? "none";
  const estimate = estimateTokens(transformedMessages);
  const effectiveTokens = Number.isSafeInteger(effectiveTokensOverride) && effectiveTokensOverride >= 0
    ? effectiveTokensOverride
    : estimate;
  const projection = {
    id: growthProjection.id ?? growthProjectionId(JSON.stringify(bindings[0]?.projectionEntryIds ?? [])),
    branchAnchorEntryId: growthProjection.branchAnchorEntryId ?? null,
  };
  const hierarchyConfig = state.compression.hierarchy;
  const tierSummaryMass = [1, 2, 3].map((tier) => ({
    tier,
    activeBlockCount: applicableBlocks.filter((block) => block.tier === tier).length,
    summaryTokensEstimate: applicableBlocks
      .filter((block) => block.tier === tier)
      .reduce((total, block) => total + block.summaryTokensEstimate, 0),
  }));
  const hierarchyCadence = hierarchyConfig.projections[projection.id] ??= {
    tier2NudgeLatched: false,
    tier3NudgeLatched: false,
    lastNudgeAt: null,
  };
  // Estimates remain useful for diagnostics and compression accounting, but
  // cadence decisions are based only on the latest provider prompt usage.
  const measuredTokens = Number.isSafeInteger(measuredContextTokensOverride) && measuredContextTokensOverride >= 0
    ? measuredContextTokensOverride
    : Number.isSafeInteger(state.metrics.piContextUsageTokens) && state.metrics.piContextUsageTokens >= 0
      ? state.metrics.piContextUsageTokens
      : null;
  const savedGrowthCadence = state.compression.growth.projections[projection.id];
  if (measuredTokens !== null && state.metrics.piContextUsageTokens == null && savedGrowthCadence) {
    savedGrowthCadence.baselineEffectiveTokens = measuredTokens;
    savedGrowthCadence.cadenceNudgeGrowthTokens = null;
  }
  const cadenceState = ensureGrowthCadence(
    state,
    projection,
    measuredTokens ?? state.compression.growth.projections[projection.id]?.baselineEffectiveTokens ?? effectiveTokens,
    state.compression.growth.growthTriggerTokens,
  );
  if (measuredTokens === null) cadenceState.nudgeDue = false;
  const percentageCadence = ensurePercentageCadence(
    state,
    projection.id,
    measuredTokens,
    usableContextWindow,
    nudgeConfig.thresholdPercentage,
    nudgeConfig.repeatEveryPercentage,
  );
  const growthNudgeDue = cadenceState.nudgeDue;
  const nudgeDue = nudgeConfig.mode === "growth"
    ? growthNudgeDue
    : nudgeConfig.mode === "percentage"
      ? percentageCadence.percentageNudgeDue
      : growthNudgeDue || percentageCadence.percentageNudgeDue;
  state.metrics = {
    ...state.metrics,
    projectedModelContextMessages: projectedMessages.length,
    projectedModelContextTokensEstimate: rawTokens,
    projectedOriginalRawContextTokensEstimate: rawTokens,
    compressionEligibleRawMessages: compressionEligible.length,
    compressionEligibleRawTokensEstimate: compressionEligible.reduce((total, binding) => total + estimateTokens(binding.message), 0),
    activeRawMessages: projectedMessages.length - covered.size,
    coveredSourceMessages: covered.size,
    sourceTokensRepresentedByApplicableBlocks: applicableBlocks.reduce((total, block) => total + block.originalSourceTokensEstimate, 0),
    applicableBlockDirectSourceTokensEstimate: applicableBlocks.reduce((total, block) => total + block.sourceTokensEstimate, 0),
    blockSummaryTokensEstimate: summaryTokens,
    effectiveTransformedContextTokensEstimate: effectiveTokens,
    protectedMessageCount: protectedBindings.length,
    protectedTokenEstimate: protectedBindings.reduce((total, binding) => total + estimateTokens(binding.message), 0),
    totalBlockCount: state.blocks.length,
    activeBlockCount: applicableBlocks.length,
    activeApplicableBlockCount: applicableBlocks.length,
    staleBlockCount: state.blocks.filter((block) => block.status === "stale").length,
    inapplicableBlockCount: [...applicability.skippedBlockReasons.values()]
      .filter((reason) => !reason.startsWith("superseded by applicable"))
      .length,
    sourceMissingBlockCount: [...applicability.skippedBlockReasons.values()]
      .filter((reason) => reason.startsWith("source entries are absent")).length,
    sourceMismatchBlockCount: [...applicability.skippedBlockReasons.values()]
      .filter((reason) => reason.startsWith("source content differs")).length,
    nonContiguousBlockCount: [...applicability.skippedBlockReasons.values()]
      .filter((reason) => reason.startsWith("source entries are not contiguous")).length,
    piContextUsageTokens: measuredTokens,
    piContextWindow: Number.isFinite(contextUsage?.contextWindow) ? contextUsage.contextWindow : null,
    usableContextWindow,
    usableContextWindowSource: usableContextWindow === null ? null :
      percentageUnavailableReason === "provider-reported overflow limit"
        ? "learned from provider overflow error"
        : "Pi-reported model contextWindow",
    currentUsedPercentage: percentageCadence.currentUsedPercentage,
    currentRemainingPercentage: percentageCadence.currentRemainingPercentage,
    contextBudgetDeltaTokens: percentageCadence.contextBudgetDeltaTokens,
    percentageStatus: percentageCadence.available ? "available" : "unavailable",
    growthMeasurementAvailable: measuredTokens !== null,
    percentageUnavailableReason: percentageCadence.available
      ? null
      : measuredTokens === null
        ? "latest provider-reported prompt usage unavailable"
        : percentageUnavailableReason,
    percentageLastDeliveredCheckpoint: percentageCadence.cadence.lastDeliveredCheckpointPercentage,
    percentageLastNudgeAt: percentageCadence.cadence.lastNudgeAt,
    percentageNextCheckpoint: percentageCadence.percentageNudgeDue
      ? percentageCadence.dueCheckpointPercentage
      : percentageCadence.nextCheckpointPercentage,
    percentageNudgeDue: percentageCadence.percentageNudgeDue,
    growthNudgeDue,
    percentageRearmed: percentageCadence.rearmed,
    normalGrowthSinceBaseline: cadenceState.growthSinceBaselineTokens,
    normalGrowthBaselineTokens: cadenceState.cadence.baselineEffectiveTokens,
    growthSinceBaselineTokens: cadenceState.growthSinceBaselineTokens,
    growthBaselineEffectiveTokens: cadenceState.cadence.baselineEffectiveTokens,
    nextNudgeAtGrowthTokens: cadenceState.nextNudgeAtGrowthTokens,
    nudgeDue,
    growthProjectionId: projection.id,
    lastNudgeAt: cadenceState.cadence.lastNudgeAt,
    lastNudgeGrowthTokens: cadenceState.cadence.lastNudgeGrowthTokens,
    lastSuccessfulCompressionAt: cadenceState.cadence.lastSuccessfulCompressionAt,
    lastSuccessfulCompressionEffectiveTokens: cadenceState.cadence.lastSuccessfulCompressionEffectiveTokens,
    lastCompressionAt: previousLastCompressionAt,
    lastCompressionResult: previousLastCompressionResult,
    hierarchy: tierSummaryMass,
    tier2PromotionDue: hierarchyConfig.enabled &&
      tierSummaryMass[0].summaryTokensEstimate >= hierarchyConfig.tier2NudgeSummaryTokens,
    tier3PromotionDue: hierarchyConfig.enabled &&
      tierSummaryMass[1].summaryTokensEstimate >= hierarchyConfig.tier3NudgeSummaryTokens,
    tier2NudgeLatched: hierarchyCadence.tier2NudgeLatched,
    tier3NudgeLatched: hierarchyCadence.tier3NudgeLatched,
  };
  return state.metrics;
}

export function persistState(filePath, state, now = new Date().toISOString()) {
  if (Object.keys(state.messageRefs).length === 0 && state.blocks.length === 0) return false;
  const folder = path.dirname(filePath);
  if (existsSync(folder) && (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory())) {
    throw new StateIntegrityError("Big-pi storage folder must be a real directory");
  }
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory()) {
    throw new StateIntegrityError("Big-pi storage folder must be a real directory");
  }
  const chunkDirectory = path.join(folder, "blocks");
  mkdirSync(chunkDirectory, { recursive: true, mode: 0o700 });
  if (lstatSync(chunkDirectory).isSymbolicLink() || !lstatSync(chunkDirectory).isDirectory()) {
    throw new StateIntegrityError("Big-pi chunk directory must be a real directory");
  }
  const index = [];
  for (const block of state.blocks) {
    const provenance = {
      sourceMessageRefs: block.sourceMessageRefs,
      effectiveOriginalMessageRefs: block.effectiveOriginalMessageRefs,
      sourceEntryIds: block.sourceEntryIds,
      sourceProjectionEntryIds: block.sourceProjectionEntryIds,
      sourceLineage: block.sourceLineage,
      sourceRefRange: block.sourceRefRange,
      sourceMessageCount: block.sourceMessageCount,
      sourceCharCount: block.sourceCharCount,
      sourceTokensEstimate: block.sourceTokensEstimate,
      originalSourceTokensEstimate: block.originalSourceTokensEstimate,
    };
    let chunkPath;
    let digest;
    if (block._storageIndex) {
      const committed = block._storageIndex;
      const expected = `${JSON.stringify({
        schemaVersion: 1,
        blockId: block.id,
        summary: block.summary,
        summaryTokensEstimate: block.summaryTokensEstimate,
        provenance,
      }, null, 2)}\n`;
      digest = createHash("sha256").update(expected).digest("hex");
      if (!block.storageError && digest !== committed.sha256) {
        throw new StateIntegrityError(`Committed chunk ${block.id} is immutable and cannot be changed`);
      }
      chunkPath = committed.chunkPath;
      digest = committed.sha256;
    } else {
      const chunk = {
        schemaVersion: 1,
        blockId: block.id,
        summary: block.summary,
        summaryTokensEstimate: block.summaryTokensEstimate,
        provenance,
      };
      const contents = `${JSON.stringify(chunk, null, 2)}\n`;
      digest = createHash("sha256").update(contents).digest("hex");
      const basePath = `blocks/${block.id}.json`;
      chunkPath = basePath;
      if (existsSync(path.join(folder, ...chunkPath.split("/")))) {
        chunkPath = `blocks/${block.id}-${digest}-${randomUUID()}.json`;
      }
      const absoluteChunkPath = path.join(folder, ...chunkPath.split("/"));
      let descriptor;
      try {
        descriptor = openSync(absoluteChunkPath, "wx", 0o600);
        writeFileSync(descriptor, contents, "utf8");
        closeSync(descriptor);
        descriptor = undefined;
        const written = readFileSync(absoluteChunkPath);
        const validated = JSON.parse(written.toString("utf8"));
        if (
          createHash("sha256").update(written).digest("hex") !== digest ||
          validated.schemaVersion !== 1 ||
          validated.blockId !== block.id ||
          validated.summary !== block.summary ||
          !validated.provenance
        ) throw new Error(`New chunk ${block.id} failed read-back validation`);
        const chunkError = chunkProvenanceError(
          { tier: block.tier, sourceBlockIds: block.sourceBlockIds },
          {
            ...validated.provenance,
            summary: validated.summary,
            summaryTokensEstimate: validated.summaryTokensEstimate,
          },
          state.messageRefs,
        );
        if (chunkError) throw new Error(`New chunk ${block.id} failed provenance validation: ${chunkError}`);
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        throw error;
      }
    }
    index.push({
      blockId: block.id,
      tier: block.tier,
      chunkPath,
      sha256: digest,
      sourceBlockIds: block.sourceBlockIds,
      createdAt: block.createdAt,
      status: block.status,
      ...(block.staleReason ? { staleReason: block.staleReason } : {}),
      supersedesBlockIds: block.supersedesBlockIds,
      supersededByBlockId: block.supersededByBlockId,
    });
  }
  const manifest = {
    ...state,
    schemaVersion: SCHEMA_VERSION,
    session: { ...state.session, updatedAt: now },
    blocks: index,
    recovery: { damagedBlocks: index.filter((entry, indexValue) => state.blocks[indexValue].storageError).map((entry) => entry.blockId) },
  };
  writeStateAtomic(filePath, manifest);
  state.session.updatedAt = now;
  for (const [indexValue, block] of state.blocks.entries()) {
    block._storageIndex = structuredClone(index[indexValue]);
  }
  return true;
}

export function storageDiskUsage(sessionPath, agentId) {
  const folder = storageFolderPath(sessionPath, agentId);
  let totalBytes = 0;
  const countFiles = (directory) => {
    for (const name of readdirSync(directory)) {
      const entryPath = path.join(directory, name);
      const info = lstatSync(entryPath);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) countFiles(entryPath);
      else if (info.isFile()) totalBytes += info.size;
    }
  };
  if (existsSync(folder)) {
    const info = lstatSync(folder);
    if (!info.isSymbolicLink() && info.isDirectory()) countFiles(folder);
  }
  return totalBytes;
}
