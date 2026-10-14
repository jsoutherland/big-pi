import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  VERSION,
  SCHEMA_VERSION,
  appendSessionDebugEvent,
  calculateEmergencyPressure,
  ProjectionError,
  StateIntegrityError,
  advanceGrowthBaseline,
  applicableCoveredRefs,
  applyCompression,
  createHierarchicalBlock,
  computeProtectedRefs,
  createLogger,
  ensureMessageReferences,
  estimateTokens,
  getBlockApplicability,
  getEffectiveOriginalRefs,
  getConfigPath,
  growthProjectionId,
  loadConfig,
  minimumSummaryTokens,
  messageText,
  persistState,
  recordPercentageNudge,
  recordGrowthNudge,
  calibrateContextEstimate,
  parseProviderContextWindow,
  readState,
  renderContextDump,
  sidecarPath,
  storageDiskUsage,
  transformContext,
  toolExchangeBlockedRefs,
  updateMetrics,
} from "./lib/big-pi.js";
export { agentStorageFolderPath, deleteAllBigPiAgentData, deleteBigPiAgentData } from "./lib/big-pi.js";

const COMPRESSION_GUIDANCE = `Compress only completed work phases whose details the agent has already consumed. Keep durable user intent and requirements, decisions, constraints, paths, identifiers, APIs and signatures, exact commands when useful, relevant unresolved errors, tests and results, open issues, and current implementation state. Prefer discarding verbose consumed tool output, duplicate or superseded exploration, intermediate chatter, repeated excerpts, and details already captured by a durable conclusion. Preserve uncertainty; never invent facts.

For work involving implementation, tests, or measurements, make the summary evidence-aware: distinguish files written from behavior verified. Preserve the exact validation command and observed result when present. Label outcomes as PASS, FAIL, or NOT VERIFIED; absent/empty output, a written report, or an assistant claim is not proof that tests ran or a metric was measured. Keep failures, caveats, and unresolved work instead of smoothing them into success. A concise checklist is useful: Changes; Decisions/constraints; Verification (command + observed result); Unverified/open work; Next step. Omit sections only when the source genuinely contains no such information.

Do not make a summary shorter than the minimum shown for its candidate. Prefer the candidate's recommendedSummaryTokens to leave room for token-estimation differences. Use concrete facts and compact bullets rather than a vague one-sentence summary. If the recommendation is too costly, choose a smaller coherent candidate; do not omit evidence just to meet a token target. For Tier 2, consolidate contiguous Tier-1 summaries while retaining durable requirements, architecture, current state, unresolved work, tests/results, errors, and chronology as needed. For Tier 3, distill multi-phase state while preserving facts needed for future work. First call big_pi_compression_sources to discover current candidates: sourceType=raw for Tier 1, or sourceType=blocks with tier=1 for Tier 2 and tier=2 for Tier 3. Select one candidate and pass its candidateId to big_pi_compress with your summary. Use candidateIds exactly as returned; they bind the request to one currently eligible range. Never guess candidate IDs, refs, or block IDs, include protected messages, mix source types/tiers, or promote one block. Every big_pi_compress call requires an agent-written summary. Legacy refs and sourceBlockIds are accepted, but candidateId is preferred. The compression engine independently enforces eligibility, protection, and the configured minimum summary retention.`;
const SOURCE_PREVIEW_CHARS = 140;
const typeBoxKind = Symbol.for("TypeBox.Kind");
const stringParameter = (description) => ({
  [typeBoxKind]: "String",
  type: "string",
  description,
});
const compressionParameters = {
  [typeBoxKind]: "Object",
  type: "object",
  properties: {
    startRef: stringParameter("Required with endRef for raw Tier-1 compression. Copy the first ref from big_pi_compression_sources with sourceType=raw."),
    endRef: stringParameter("Required with startRef for raw Tier-1 compression. Copy the last ref from the same returned eligible range."),
    candidateId: stringParameter("Preferred: copy candidateId from one currently returned candidate by big_pi_compression_sources. This binds the request to that exact validated range."),
    sourceBlockIds: {
      [typeBoxKind]: "Array",
      type: "array",
      items: stringParameter("Block ID copied from a contiguous candidate returned by big_pi_compression_sources with sourceType=blocks and tier=1 or tier=2."),
      minItems: 2,
      description: "Required instead of startRef/endRef for same-tier promotion; use every sourceBlockId from one returned candidate.",
    },
    summary: stringParameter("Always required. Write an evidence-aware summary yourself. Preserve user intent, decisions, paths, implementation state, exact verification commands/results, failures, uncertainty, and open work. Distinguish files written from behavior verified."),
  },
  required: ["summary"],
  oneOf: [
    { required: ["candidateId"] },
    { required: ["startRef", "endRef"] },
    { required: ["sourceBlockIds"] },
  ],
  additionalProperties: false,
};

export default function bigPi(pi) {
  const agentId = process.env.BIG_PI_AGENT_ID || undefined;
  const warnings = [];
  const { config, configPath } = loadConfig(process.env, (warning) => warnings.push(warning));
  const log = createLogger({ debug: config.debug });
  const debugEvent = (sessionPath, event, details = {}) =>
    appendSessionDebugEvent(sessionPath, event, details, process.env, agentId);
  const debugFailureCategory = (error) => {
    const message = error instanceof Error ? error.message : "";
    if (/summary is too short/i.test(message)) return "summary_too_short";
    if (/minimum compression range|too small/i.test(message)) return "range_too_small";
    if (/source.*(stale|eligible|range)|ref/i.test(message)) return "source_validation";
    if (/manifest|persist|write|rename/i.test(message)) return "storage";
    return "other";
  };
  const notifiedFailures = new Set();
  const percentageUnavailableWarnings = new Set();
  const hierarchyApplicabilityWarnings = new Set();
  const warnUser = (ctx, message, diagnosticKey) => {
    if (diagnosticKey && notifiedFailures.has(diagnosticKey)) return;
    if (diagnosticKey) notifiedFailures.add(diagnosticKey);
    log("error", message);
    try {
      ctx?.ui.notify(`big-pi: ${message}`, "warning");
    } catch {
      console.error(`big-pi: ${message}`);
    }
  };
  for (const warning of warnings) warnUser(undefined, warning);

  let state;
  let activeSessionPath;
  let disabledSessionPath;
  let disabledSessionReason;
  const compactionDiagnostics = new Map();
  const learnedContextWindows = new Map();
  const lastSentEstimates = new Map();
  const providerUsageAnchors = new Map();
  const awaitingPostCompactionUsage = new Set();
  const awaitingEmergencyUsageAfterFallback = new Set();
  const usageMeterKey = (ctx) =>
    `${ctx.sessionManager.getSessionId?.() ?? "<session>"}\0${ctx.model?.id ?? "default"}`;
  const emergencyAttempts = new Map();
  const compressionPhases = new Map();
  const issuedCompressionCandidates = new Map();
  const pendingCompressionGuidance = new Map();
  // One intercepted threshold request gives model-driven compression a chance.
  // When Pi's threshold lands just below a configured percentage checkpoint,
  // allow one extra request so the pending advisory can reach the agent.
  const thresholdInterceptions = new Map();
  const compressionTools = new Set(["big_pi_compression_sources", "big_pi_compress"]);
  const MAX_COMPRESSION_REQUESTS = 6;
  const MAX_ISSUED_CANDIDATES = 512;

  function phaseKey(current) {
    return emergencyKey(current.sessionPath, current.growthProjection.id);
  }

  function endCompressionPhase(current, outcome) {
    pendingCompressionGuidance.delete(phaseKey(current));
    if (outcome === "committed") thresholdInterceptions.delete(phaseKey(current));
    const phase = compressionPhases.get(phaseKey(current));
    if (!phase || !compressionPhases.delete(phaseKey(current))) return;
    debugEvent(current.sessionPath, "compression_phase_ended", {
      outcome,
      requests: phase.requests,
      compressionAttempts: phase.compressionAttempts,
      failedAttempts: phase.failedAttempts,
    });
    log(outcome === "committed" ? "info" : "warning", `[compression] phase ended: ${outcome}; requests=${phase.requests} compressionAttempts=${phase.compressionAttempts} failedAttempts=${phase.failedAttempts}`);
  }

  function yieldCompressionPhaseToPi(current, phase, reason) {
    const runtime = emergencyRuntime(current);
    if (runtime.nativeFallbackState === "none") {
      runtime.nativeFallbackState = "pending";
      if (runtime.activeEpisode === "none") runtime.activeEpisode = "pressure";
      const lastReason = reason ?? "Emergency compression turn ended without committing a block; yielding to Pi native compaction";
      try {
        persistEmergency(current, {
          lastOutcome: "fallback-pending",
          nativeFallbackState: "pending",
          activeEpisode: runtime.activeEpisode,
          lastReason,
        });
      } catch (error) {
        log("warning", `[emergency] could not persist native fallback handoff reason=${error.message}`);
      }
      debugEvent(current.sessionPath, "emergency_phase_yielded_to_pi", {
        requests: phase?.requests ?? 0,
        attempt: runtime.attempts,
        episode: runtime.activeEpisode,
      });
      log("warning", `[emergency] ${lastReason}`);
    }
    endCompressionPhase(current, "yielded to Pi native compaction");
  }


  function diagnosticsFor(sessionPath) {
    const key = sessionPath ?? "<unknown-session>";
    let diagnostics = compactionDiagnostics.get(key);
    if (!diagnostics) {
      diagnostics = {
        attempts: 0,
        cancelled: 0,
        lastAttemptAt: null,
        lastResult: "not attempted",
        lastReason: null,
      };
      compactionDiagnostics.set(key, diagnostics);
    }
    return diagnostics;
  }

  function emergencyKey(sessionPath, projectionId) {
    return `${sessionPath}\0${projectionId}`;
  }

  function emergencyRecord(current) {
    const projections = current.state.compression.emergency.projections;
    return projections[current.growthProjection.id] ??= {
      lastPressureAt: null,
      lastOverflowAt: null,
      lastOverflowReason: null,
      lastOutcome: "none",
      nativeFallbackState: "none",
      activeEpisode: "none",
      lastEstimatedReclaimTokens: null,
      lastReason: null,
    };
  }

  function piOwnsCompaction(runtime) {
    return runtime.nativeFallbackState === "pending" || runtime.nativeFallbackState === "failed";
  }

  function emergencyRuntime(current) {
    const key = emergencyKey(current.sessionPath, current.growthProjection.id);
    let runtime = emergencyAttempts.get(key);
    if (runtime) return runtime;
    runtime = {
      attempts: 0,
      active: false,
      overflowActive: false,
      interrupted: false,
      nativeFallbackState: "none",
      activeEpisode: "none",
      lastAttemptEffectiveTokens: null,
      retryAfterNoToolCall: false,
      compressionFollowUpQueued: false,
      compressionFollowUpStarted: false,
    };
    const record = emergencyRecord(current);
    runtime.nativeFallbackState = record.nativeFallbackState;
    runtime.activeEpisode = record.activeEpisode;
    if (record.lastOutcome === "requested" || record.lastOutcome === "partial") {
      runtime.attempts = config.emergency.maxAttemptsPerTurn;
      runtime.active = true;
      runtime.nativeFallbackState = "pending";
      runtime.interrupted = true;
      runtime.overflowActive = runtime.activeEpisode === "overflow";
      runtime.lastAttemptEffectiveTokens = current.state.metrics.piContextUsageTokens;
      record.lastOutcome = "interrupted";
      record.nativeFallbackState = "pending";
      record.lastReason = "extension restarted during recovery; automatic retry suppressed";
      try {
        persistState(current.sidecar, current.state);
      } catch (error) {
        log("error", `[emergency] could not persist restart diagnostic: ${error.message}`);
      }
      log("warning", "[emergency] persisted recovery was interrupted by restart; automatic retry suppressed");
    } else if (record.nativeFallbackState === "pending" || record.nativeFallbackState === "failed") {
      runtime.attempts = config.emergency.maxAttemptsPerTurn;
      runtime.active = true;
      runtime.overflowActive = runtime.activeEpisode === "overflow";
      runtime.lastAttemptEffectiveTokens = current.state.metrics.piContextUsageTokens;
    } else if (record.lastOutcome === "failed" && record.activeEpisode === "pressure") {
      runtime.attempts = config.emergency.maxAttemptsPerTurn;
      runtime.active = true;
      runtime.lastAttemptEffectiveTokens = current.state.metrics.piContextUsageTokens;
    }
    emergencyAttempts.set(key, runtime);
    return runtime;
  }

  function emergencyPressure(current) {
    return calculateEmergencyPressure(
      current.state.metrics.piContextUsageTokens,
      current.state.metrics.usableContextWindow,
      config.emergency,
    );
  }

  function currentEmergencyState(current, runtime = emergencyRuntime(current)) {
    const pressure = emergencyPressure(current);
    if (current.state.metrics.piContextUsageTokens === null) {
      return runtime.overflowActive ? "OVERFLOW" : "NORMAL";
    }
    if (runtime.overflowActive && (pressure.targetEffectiveTokens === null ||
      (current.state.metrics.piContextUsageTokens === null || current.state.metrics.piContextUsageTokens > pressure.targetEffectiveTokens))) {
      return "OVERFLOW";
    }
    if (config.emergency.enabled && (pressure.pressure || (runtime.active && (pressure.targetEffectiveTokens === null ||
      (current.state.metrics.piContextUsageTokens === null || current.state.metrics.piContextUsageTokens > pressure.targetEffectiveTokens))))) {
      return "PRESSURE";
    }
    return "NORMAL";
  }

  function persistEmergency(current, updates) {
    Object.assign(emergencyRecord(current), updates);
    persistState(current.sidecar, current.state);
  }

  function settleEmergency(current, ctx, compressionEvidence = false) {
    const runtime = emergencyRuntime(current);
    const pressure = emergencyPressure(current);
    if (
      runtime.nativeFallbackState === "pending" ||
      !runtime.active ||
      pressure.targetEffectiveTokens === null ||
      current.state.metrics.piContextUsageTokens === null ||
      current.state.metrics.piContextUsageTokens > pressure.targetEffectiveTokens) {
      return runtime;
    }
    const interruptedOverflow = runtime.activeEpisode === "overflow";
    runtime.attempts = 0;
    runtime.active = false;
    runtime.overflowActive = false;
    runtime.nativeFallbackState = "none";
    runtime.activeEpisode = "none";
    runtime.interrupted = false;
    runtime.lastAttemptEffectiveTokens = null;
    persistEmergency(current, {
      lastOutcome: "recovered",
      nativeFallbackState: "none",
      activeEpisode: "none",
      lastReason: null,
    });
    log("info", `[emergency] recovery successful used=${pressure.usedPercentage?.toFixed(1) ?? "unknown"}`);
    try {
      ctx.ui.notify(interruptedOverflow
        ? "big-pi recovered overflow context. Pi is continuing the active task from retained context."
        : "big-pi recovered context pressure.", interruptedOverflow ? "warning" : "info");
    } catch {
      // Recovery must not depend on UI availability.
    }
    return runtime;
  }

  function emergencyGuidance(current, attempt, overflow = false) {
    const pressure = emergencyPressure(current);
    const metrics = current.state.metrics;
    const context = pressure.usedPercentage === null
      ? "Pi has reported an actual context overflow; no reliable context-window denominator is available, so percentages and token targets are unavailable."
      : `Provider-reported prompt context is ${pressure.usedPercentage.toFixed(1)}% used and ` +
        `${pressure.remainingPercentage.toFixed(1)}% remaining (${formatTokens(metrics.piContextUsageTokens)} / ` +
        `${formatTokens(metrics.usableContextWindow)} tokens). The emergency target is ${config.emergency.targetPercentageAfterCompression}% ` +
        `(~${formatTokens(pressure.targetEffectiveTokens)} tokens); reclaim needed is about ` +
        `${formatTokens(pressure.estimatedReclaimTokens)} tokens.`;
    const rawAvailable = compressionSources(current).length > 0;
    const tier1PromotionAvailable = blockCompressionSources(current, 1).length > 0;
    const tier2PromotionAvailable = blockCompressionSources(current, 2).length > 0;
    const hierarchyAvailable = tier1PromotionAvailable || tier2PromotionAvailable;
    const hierarchyFallback = !rawAvailable && hierarchyAvailable;
    const sourceInstructions = hierarchyFallback
      ? `No raw range is eligible. Call big_pi_compression_sources with {"sourceType":"blocks","tier":${tier1PromotionAvailable ? 1 : 2}} and use one returned candidateId.`
      : `Call big_pi_compression_sources with {"sourceType":"raw"}. Choose one returned eligibleRanges[].candidateId.`;
    const hierarchyInstruction = !hierarchyFallback && hierarchyAvailable
      ? " If raw reclaim is insufficient, inspect block candidates with sourceType=blocks and tier=1 or 2."
      : "";
    return `big-pi emergency ${overflow ? "overflow recovery" : "pressure"} (attempt ${attempt}/${config.emergency.maxAttemptsPerTurn}): ${context} ` +
      `Pause the application task. Your next response must be a tool call, not prose. ${sourceInstructions} Then call big_pi_compress with {"candidateId":"<exact returned id>","summary":"<your evidence-aware summary>"}. ` +
      `Meet candidate.minimumSummaryTokens; prefer recommendedSummaryTokens. Preserve durable facts, decisions, verification results, failures, and open work. Never guess IDs or weaken protection, provenance, or tier validation.${hierarchyInstruction} ` +
      `If a call is rejected, follow its error, refresh candidates if stale, and retry with corrected fields; do not repeat identical arguments. If no safe candidate exists, report that limitation. After compression or native recovery, resume the user's task automatically without asking the user to resubmit.` +
      (overflow ? " The exact interrupted request may not be replayable; continue from preserved task context." : "");
  }

  function markEmergencyCompression(current, ctx) {
    const key = emergencyKey(current.sessionPath, current.growthProjection.id);
    const runtime = emergencyAttempts.get(key);
    if (!runtime?.active) return;
    const pressure = emergencyPressure(current);
    const measured = current.state.metrics.piContextUsageTokens;
    // Compression changes the next prompt. Discard the pre-compression
    // provider anchor and wait for Pi's next completion usage before deciding
    // whether the emergency target was reached.
    providerUsageAnchors.delete(usageMeterKey(ctx));
    lastSentEstimates.delete(usageMeterKey(ctx));
    current.state.metrics.piContextUsageTokens = null;
    if (measured === null) {
      persistEmergency(current, {
        lastOutcome: "partial",
        activeEpisode: runtime.activeEpisode,
        nativeFallbackState: runtime.nativeFallbackState,
        lastEstimatedReclaimTokens: null,
        lastReason: "compression applied; awaiting provider-measured context",
      });
      return;
    }
    persistEmergency(current, {
      lastOutcome: "partial",
      activeEpisode: runtime.activeEpisode,
      nativeFallbackState: runtime.nativeFallbackState,
      lastEstimatedReclaimTokens: pressure.estimatedReclaimTokens,
      lastReason: "compression applied; awaiting provider-measured context",
    });
    log("info", "[emergency] compression applied; waiting for provider-measured context before checking recovery");
  }

  function getSessionPath(ctx) {
    return ctx.sessionManager.getSessionFile?.();
  }

  function rememberIntegrityFailure(ctx, error) {
    let sessionPath;
    try {
      sessionPath = getSessionPath(ctx);
    } catch {
      return;
    }
    if (sessionPath && disabledSessionPath !== sessionPath) {
      disabledSessionPath = sessionPath;
      disabledSessionReason = error.message;
    }
  }

  function loadForContext(ctx) {
    const sessionPath = getSessionPath(ctx);
    if (!sessionPath) throw new Error("No active Pi session file");
    if (disabledSessionPath === sessionPath) {
      throw new StateIntegrityError(disabledSessionReason || "big-pi is disabled for this session after an integrity error");
    }
    if (sessionPath !== activeSessionPath || !state) {
      const sidecar = sidecarPath(sessionPath, agentId);
      const loaded = readState(sidecar, sessionPath, agentId);
      state = loaded.state;
      activeSessionPath = sessionPath;
      log(loaded.missing ? "info" : "debug", `${loaded.missing ? "deferred" : "reloaded"} manifest ${sidecar}`);
      for (const item of loaded.recovery ?? []) {
        warnUser(
          ctx,
          `committed chunk ${item.blockId} at ${item.chunkPath} is unavailable or invalid (${item.reason}); its raw range and dependent higher-tier summaries will remain visible. Restore the chunk from a trusted backup or leave it in place for diagnostics.`,
          `${sessionPath}:${item.blockId}:${item.reason}`,
        );
      }
      if (!loaded.missing && Object.keys(state.compression.growth.projections).length) {
        log("info", `[nudge] restored cadence state from manifest (${Object.keys(state.compression.growth.projections).length} projection(s))`);
      }
    }
    return { sessionPath, agentId, sidecar: sidecarPath(sessionPath, agentId), state };
  }

  function projection(ctx) {
    const result = ctx.sessionManager.buildSessionProjection();
    if (!result || !Array.isArray(result.entries) || !Array.isArray(result.messages)) {
      throw new Error("Pi did not return a valid session projection");
    }
    return result;
  }

  function contextWindowInfo(ctx, contextUsage) {
    const reportedWindow = contextUsage?.contextWindow;
    const modelWindow = ctx.model?.contextWindow;
    const reported = Number.isSafeInteger(reportedWindow) && reportedWindow > 0
      ? reportedWindow
      : Number.isSafeInteger(modelWindow) && modelWindow > 0 ? modelWindow : null;
    const modelId = ctx.model?.id ?? "default";
    const learned = learnedContextWindows.get(`${ctx.sessionManager.getSessionId?.() ?? "<session>"}\0${modelId}`);
    if (learned && (!reported || learned < reported)) {
      return { contextWindow: learned, reason: "provider-reported overflow limit" };
    }
    return reported
      ? { contextWindow: reported, reason: null }
      : { contextWindow: null, reason: "Pi did not expose a positive current model contextWindow" };
  }

  // Keep provider-reported prompt plus generated-token counts as the source
  // for post-turn threshold decisions. Estimates only calibrate projections.
  pi.on("turn_end", (event, ctx) => {
    const message = event.message;
    const usage = message?.usage;
    if (message?.role !== "assistant" || !usage || typeof usage !== "object") return;
    const key = usageMeterKey(ctx);
    const estimateAtRequest = lastSentEstimates.get(key);
    const promptTokens = [usage.input, usage.cacheRead, usage.cacheWrite]
      .filter(Number.isSafeInteger)
      .reduce((sum, value) => sum + value, 0);
    const outputTokens = Number.isSafeInteger(usage.output) && usage.output >= 0 ? usage.output : 0;
    const contextTokensAfterTurn = promptTokens + outputTokens;
    if (contextTokensAfterTurn > 0) {
      awaitingPostCompactionUsage.delete(key);
      awaitingEmergencyUsageAfterFallback.delete(key);
      let measuredProjectionId = null;
      try {
        const measuredProjection = projection(ctx);
        const sessionPath = getSessionPath(ctx);
        measuredProjectionId = growthProjection(ctx, measuredProjection, sessionPath).id;
      } catch {
        // Keep the measurement unavailable to branch-scoped pressure checks.
      }
      providerUsageAnchors.set(key, {
        contextTokensAfterTurn,
        inputTokens: promptTokens,
        outputTokens,
        estimateAtRequest,
        growthProjectionId: measuredProjectionId,
      });
      debugEvent(getSessionPath(ctx), "provider_usage_observed", {
        inputTokens: promptTokens,
        outputTokens,
        contextTokensAfterTurn,
        contextWindow: contextWindowInfo(ctx, usage).contextWindow,
        projection: measuredProjectionId,
      });
      log("debug", `[usage] provider turn complete input=${promptTokens} output=${outputTokens} contextAfter=${contextTokensAfterTurn} source=provider`);
    }
  });

  // Learn a concrete provider window from overflow errors before Pi's
  // session_before_compact overflow hook runs. The learned value is scoped to
  // this session and model; existing Big Pi integrity/fallback decisions stay
  // authoritative.
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message?.role !== "assistant" || message.stopReason !== "error") return;
    const detail = `${message.errorMessage ?? ""}\n${Array.isArray(message.content) ? message.content.map((part) => part?.text ?? "").join("\n") : ""}`;
    const window = parseProviderContextWindow(detail);
    if (!window) return;
    const modelId = ctx.model?.id ?? "default";
    learnedContextWindows.set(`${ctx.sessionManager.getSessionId?.() ?? "<session>"}\0${modelId}`, window);
    log("warning", `[emergency] provider error reported context window=${window}; using it for this session/model`);
  });

  function formatTokens(value) {
    return Number(value ?? 0).toLocaleString("en-US");
  }

  function percentageWording(metrics) {
    const used = metrics.currentUsedPercentage;
    const remaining = metrics.currentRemainingPercentage;
    const window = metrics.usableContextWindow;
    const delta = metrics.contextBudgetDeltaTokens;
    if (used === null || remaining === null || window === null || delta === null) return "";
    const usedText = `${used.toFixed(1)}%`;
    const remainingText = `${remaining.toFixed(1)}%`;
    if (config.nudge.display === "remaining") {
      if (remaining < 0) {
        return `Provider-reported prompt context is approximately ${remainingText} of the nominal context remaining; ` +
          `it is about ${formatTokens(-delta)} tokens over budget (${usedText} used).`;
      }
      return `Approximately ${remainingText} of the nominal context remains ` +
        `(${formatTokens(delta)} of ${formatTokens(window)} tokens; ${usedText} used).`;
    }
    if (remaining < 0) {
      return `Provider-reported prompt context is approximately ${usedText} used ` +
        `(${formatTokens(metrics.piContextUsageTokens)} / ${formatTokens(window)}; ` +
        `${formatTokens(-delta)} tokens over budget, ${remainingText} remaining).`;
    }
    return `Provider-reported prompt context is approximately ${usedText} used ` +
      `(${formatTokens(metrics.piContextUsageTokens)} / ${formatTokens(window)}; ` +
      `~${formatTokens(delta)} tokens remain).`;
  }

  function buildNudge(metrics, growthDue, percentageDue, deliveredCheckpoint, thresholdAdvisory = false) {
    const details = [];
    if (growthDue) {
      details.push(
        `another ${formatTokens(config.nudge.growthTriggerTokens)} tokens have accumulated since the last growth checkpoint`,
      );
    }
    if (percentageDue && metrics.currentUsedPercentage !== null) {
      details.push(
        thresholdAdvisory
          ? `Pi requested its native threshold compaction at ${metrics.currentUsedPercentage.toFixed(1)}% used; deliver the pending ${deliveredCheckpoint}% Big Pi checkpoint advisory`
          : `${percentageWording(metrics)} (percentage checkpoint ${deliveredCheckpoint}%)`,
      );
    }
    if (!details.length && metrics.currentUsedPercentage !== null) {
      details.push(percentageWording(metrics));
    }
    const diagnostic = details.length ? ` ${details.join(" and ")}.` : "";
    return `big-pi advisory:${diagnostic} Consider compression after a consumed/completed work phase if an older contiguous semantic range is no longer needed verbatim. Keep recent and active work raw, preserve durable facts, prefer task boundaries, and decline if no suitable consumed range exists. Compression is optional; use the existing big-pi compression tools if appropriate. Growth is only a reminder cadence, never a chunk size.`;
  }

  function growthProjection(ctx, currentProjection, sessionPath) {
    const sessionManager = ctx.sessionManager;
    const treeRoots = sessionManager.getTree?.();
    const entriesById = new Map();
    const visit = (nodes) => {
      for (const node of nodes ?? []) {
        if (node?.entry?.id) entriesById.set(node.entry.id, node.entry);
        visit(node?.children);
      }
    };
    if (Array.isArray(treeRoots)) visit(treeRoots);
    const childrenByParent = new Map();
    for (const entry of entriesById.values()) {
      const parentId = entry.parentId ?? null;
      const children = childrenByParent.get(parentId) ?? [];
      children.push(entry);
      childrenByParent.set(parentId, children);
    }
    let branchAnchorEntryId = null;
    for (const projectedEntry of currentProjection.entries) {
      const entry = projectedEntry.sourceEntry;
      const siblings = childrenByParent.get(entry?.parentId ?? null) ?? [];
      if (siblings.length < 2) continue;
      const canonical = [...siblings].sort((left, right) =>
        String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? "")) ||
        String(left.id).localeCompare(String(right.id))
      )[0];
      if (entry.id !== canonical.id) branchAnchorEntryId = entry.id;
    }
    const sessionId = sessionManager.getSessionId?.() ?? sessionPath;
    return {
      id: growthProjectionId(JSON.stringify([sessionId, branchAnchorEntryId ?? "session-root"])),
      branchAnchorEntryId,
    };
  }

  function refresh(ctx, persist = true) {
    const loaded = loadForContext(ctx);
    const currentProjection = projection(ctx);
    const currentGrowthProjection = growthProjection(ctx, currentProjection, loaded.sessionPath);
    loaded.state.compression.growth.growthTriggerTokens = config.nudge.growthTriggerTokens;
    loaded.state.compression.percentage.thresholdPercentage = config.nudge.thresholdPercentage;
    loaded.state.compression.percentage.repeatEveryPercentage = config.nudge.repeatEveryPercentage;
    Object.assign(loaded.state.compression.hierarchy, config.hierarchy);
    const bindings = ensureMessageReferences(loaded.state, currentProjection);
    const protectedRegion = computeProtectedRefs(bindings, config);
    const transformed = transformContext(currentProjection.messages, bindings, loaded.state.blocks, protectedRegion.refs);
    const previousCadence = loaded.state.compression.growth.projections[currentGrowthProjection.id];
    const effectiveTokens = estimateTokens(transformed);
    if (loaded.state.metrics.growthProjectionId !== currentGrowthProjection.id) {
      loaded.state.metrics.piContextUsageTokens = null;
    }
    const usageAnchor = providerUsageAnchors.get(usageMeterKey(ctx));
    const measuredContextTokens = usageAnchor?.growthProjectionId === currentGrowthProjection.id
      ? usageAnchor.contextTokensAfterTurn
      : null;
    if (!previousCadence) {
      log("info", `[nudge] baseline initialized projection=${currentGrowthProjection.id.slice(0, 12)} tokens=${effectiveTokens} (estimated effective context)`);
    } else if (effectiveTokens < previousCadence.baselineEffectiveTokens) {
      log("info", `[nudge] baseline reset after effective context decreased projection=${currentGrowthProjection.id.slice(0, 12)} tokens=${effectiveTokens}`);
    }
    const usageKey = usageMeterKey(ctx);
    const awaitingFreshUsage = awaitingPostCompactionUsage.has(usageKey);
    if (awaitingFreshUsage) loaded.state.metrics.piContextUsageTokens = null;
    const reportedContextUsage = ctx.getContextUsage?.();
    const contextUsage = awaitingFreshUsage && reportedContextUsage && typeof reportedContextUsage === "object"
      ? { ...reportedContextUsage, tokens: null, percent: null }
      : reportedContextUsage;
    const windowInfo = contextWindowInfo(ctx, contextUsage);
    updateMetrics(
      loaded.state,
      bindings,
      protectedRegion.refs,
      currentProjection.messages,
      transformed,
      contextUsage,
      currentGrowthProjection,
      config.nudge,
      windowInfo.contextWindow,
      windowInfo.reason,
      null,
      measuredContextTokens,
    );
    if (config.nudge.mode !== "growth" && windowInfo.contextWindow === null) {
      const warningKey = `${currentGrowthProjection.id}:${windowInfo.reason}`;
      if (!percentageUnavailableWarnings.has(warningKey)) {
        percentageUnavailableWarnings.add(warningKey);
        log("warning", `[nudge] percentage unavailable: ${windowInfo.reason}`);
      }
    }
    if (persist && currentProjection.messages.length > 0) {
      persistState(loaded.sidecar, loaded.state);
      log("debug", `manifest persisted ${loaded.sidecar}`);
    }
    const applicability = getBlockApplicability(currentProjection.messages, bindings, loaded.state.blocks, protectedRegion.refs);
    for (const block of loaded.state.blocks) {
      const reason = applicability.skippedBlockReasons.get(block.id);
      if (block.tier < 2 || !reason?.startsWith("descendant")) continue;
      const key = `${currentGrowthProjection.id}:${block.id}:${reason}`;
      if (hierarchyApplicabilityWarnings.has(key)) continue;
      hierarchyApplicabilityWarnings.add(key);
      log("warning", `[hierarchy] block ${block.id} inapplicable on current projection: ${reason}`);
    }
    return {
      ...loaded,
      projection: currentProjection,
      bindings,
      protectedRegion,
      transformed,
      applicability,
      growthProjection: currentGrowthProjection,
      emergencyPressure: calculateEmergencyPressure(
        loaded.state.metrics.piContextUsageTokens,
        loaded.state.metrics.usableContextWindow,
        config.emergency,
      ),
    };
  }

  function compactionOwnership(ctx) {
    let sessionPath;
    try {
      sessionPath = getSessionPath(ctx);
      if (!sessionPath) return { owns: false, reason: "No active Pi session file" };
      if (disabledSessionPath === sessionPath) {
        return {
          owns: false,
          reason: disabledSessionReason || "big-pi state was disabled for this session after an integrity error",
        };
      }
      const loaded = loadForContext(ctx);
      const currentProjection = projection(ctx);
      const bindings = ensureMessageReferences(loaded.state, currentProjection);
      const protectedRegion = computeProtectedRefs(bindings, config);
      transformContext(currentProjection.messages, bindings, loaded.state.blocks, protectedRegion.refs);
      return { owns: true, reason: null };
    } catch (error) {
      if (error instanceof StateIntegrityError && sessionPath) rememberIntegrityFailure(ctx, error);
      return { owns: false, reason: error.message || "big-pi state could not be validated" };
    }
  }

  function historicalCompactionStatus(ctx) {
    try {
      const branch = ctx.sessionManager.getBranch?.();
      if (!Array.isArray(branch)) return "unavailable";
      return branch.some((entry) => entry?.type === "compaction")
        ? "present (left intact; not created by big-pi)"
        : "not detected";
    } catch {
      return "unavailable";
    }
  }

  function persistCompression(current, ctx, block) {
    const previousEffectiveTokens = current.state.metrics.effectiveTransformedContextTokensEstimate;
    providerUsageAnchors.delete(usageMeterKey(ctx));
    lastSentEstimates.delete(usageMeterKey(ctx));
    current.state.metrics.piContextUsageTokens = null;
    const metrics = current.state.metrics;
    current.state.metrics.lastCompressionAt = block.createdAt;
    current.state.metrics.lastCompressionResult = `created ${block.id}`;
    const transformed = transformContext(
      current.projection.messages,
      current.bindings,
      current.state.blocks,
      current.protectedRegion.refs,
    );
    updateMetrics(
      current.state,
      current.bindings,
      current.protectedRegion.refs,
      current.projection.messages,
      transformed,
      ctx.getContextUsage?.(),
      current.growthProjection,
      config.nudge,
      current.state.metrics.usableContextWindow,
      current.state.metrics.percentageUnavailableReason,
    );
    advanceGrowthBaseline(
      current.state,
      current.growthProjection.id,
      current.state.metrics.effectiveTransformedContextTokensEstimate,
      block.createdAt,
    );
    current.state.metrics.growthBaselineEffectiveTokens = current.state.compression.growth.projections[
      current.growthProjection.id
    ].baselineEffectiveTokens;
    current.state.metrics.normalGrowthBaselineTokens = current.state.metrics.growthBaselineEffectiveTokens;
    current.state.metrics.growthSinceBaselineTokens = 0;
    current.state.metrics.normalGrowthSinceBaseline = 0;
    current.state.metrics.nextNudgeAtGrowthTokens = config.nudge.growthTriggerTokens;
    current.state.metrics.nudgeDue = false;
    current.state.metrics.lastSuccessfulCompressionAt = block.createdAt;
    current.state.metrics.lastSuccessfulCompressionEffectiveTokens = current.state.metrics.effectiveTransformedContextTokensEstimate;
    markEmergencyCompression(current, ctx);
    persistState(current.sidecar, current.state);
    log("info", `[nudge] baseline advanced after compression projection=${current.growthProjection.id.slice(0, 12)} effective=${current.state.metrics.effectiveTransformedContextTokensEstimate}`);
    if (block.tier > 1) {
      log("info", `[hierarchy] created ${block.id} tier=${block.tier} children=${block.sourceBlockIds.join(",")}`);
      log("info", `[hierarchy] superseded children=${block.sourceBlockIds.join(",")}`);
    } else {
      log("info", `created ${block.id}: ${block.sourceMessageCount} messages, ${block.sourceCharCount} chars`);
    }
  }

  function compressionSources(current) {
    const covered = applicableCoveredRefs(
      current.bindings,
      current.state.blocks,
      current.protectedRegion.refs,
      current.projection.messages,
    );
    const unsafeToolRefs = toolExchangeBlockedRefs(
      current.projection.messages,
      current.bindings,
      new Set([...current.protectedRegion.refs, ...covered]),
    );
    const ranges = [];
    let range = [];
    let previousContextIndex = null;
    const finishRange = () => {
      if (range.reduce((total, binding) => total + messageText(binding.message).length, 0) >= config.minCompressRangeChars) {
        ranges.push(range);
      }
      range = [];
      previousContextIndex = null;
    };
    for (const binding of current.bindings) {
      if (
        current.protectedRegion.refs.has(binding.ref) ||
        covered.has(binding.ref) ||
        unsafeToolRefs.has(binding.ref) ||
        (previousContextIndex !== null && binding.contextIndex !== previousContextIndex + 1)
      ) {
        finishRange();
      }
      if (
        !current.protectedRegion.refs.has(binding.ref) &&
        !covered.has(binding.ref) &&
        !unsafeToolRefs.has(binding.ref)
      ) {
        range.push(binding);
        previousContextIndex = binding.contextIndex;
      }
    }
    finishRange();
    return ranges.map((bindings) => {
      const sourceTokensEstimate = bindings.reduce((total, binding) => total + estimateTokens(binding.message), 0);
      const startRef = bindings[0].ref;
      const endRef = bindings.at(-1).ref;
      const minimumSummary = minimumSummaryTokens(sourceTokensEstimate, config.minSummaryRetentionPercent);
      return {
        sourceType: "raw",
        candidateId: compressionCandidateId(current, "raw", [startRef, endRef]),
        startRef,
        endRef,
        sourceChars: bindings.reduce((total, binding) => total + messageText(binding.message).length, 0),
        sourceTokensEstimate,
        minimumSummaryTokens: minimumSummary,
        recommendedSummaryTokens: Math.max(minimumSummary + 32, Math.ceil(minimumSummary * 1.1)),
        sources: bindings.map((binding) => {
          const content = messageText(binding.message).replace(/\s+/g, " ").trim();
          return {
            ref: binding.ref,
            role: binding.message.role,
            sourceChars: messageText(binding.message).length,
            preview: content.length > SOURCE_PREVIEW_CHARS
              ? `${content.slice(0, SOURCE_PREVIEW_CHARS - 1)}…`
              : content,
          };
        }),
      };
    });
  }

  function compressionCandidateId(current, sourceType, values) {
    return `C-${createHash("sha256")
      .update(JSON.stringify([current.growthProjection.id, sourceType, values]))
      .digest("hex")
      .slice(0, 16)}`;
  }

  function candidateCacheKey(current, candidateId) {
    return `${phaseKey(current)}\0${candidateId}`;
  }

  function rememberCompressionCandidates(current, candidates, sourceType = "raw", tier) {
    const compact = candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      sourceType: candidate.sourceType,
      startRef: candidate.startRef,
      endRef: candidate.endRef,
      tier: candidate.tier,
      sourceBlockIds: candidate.sourceBlockIds ? [...candidate.sourceBlockIds] : undefined,
      minimumSummaryTokens: candidate.minimumSummaryTokens,
      recommendedSummaryTokens: candidate.recommendedSummaryTokens,
    }));
    for (const candidate of compact) {
      const key = candidateCacheKey(current, candidate.candidateId);
      issuedCompressionCandidates.delete(key);
      issuedCompressionCandidates.set(key, candidate);
    }
    while (issuedCompressionCandidates.size > MAX_ISSUED_CANDIDATES) {
      issuedCompressionCandidates.delete(issuedCompressionCandidates.keys().next().value);
    }
    const phase = compressionPhases.get(phaseKey(current));
    if (phase) {
      phase.lastFailure = undefined;
      phase.lastDiscovery = {
        sourceType,
        tier,
        candidates: compact.map(({ candidateId, minimumSummaryTokens, recommendedSummaryTokens }) => ({
          candidateId,
          minimumSummaryTokens,
          recommendedSummaryTokens,
        })),
      };
    }
  }

  function compressionPhaseStep(phase) {
    if (phase.lastFailure) {
      return "The last big_pi_compress call was rejected. Read its tool error and correct that specific problem now. Do not repeat source discovery unless the error explicitly says the candidate is stale; if so, discover once and compress the newly returned candidate on the next response.";
    }
    const discovery = phase.lastDiscovery;
    if (discovery?.candidates.length) {
      const choices = discovery.candidates.map((candidate) =>
        `${candidate.candidateId} (minimum ${candidate.minimumSummaryTokens} tokens; recommended ${candidate.recommendedSummaryTokens})`
      ).join(", ");
      return `Source discovery already succeeded. Do not call big_pi_compression_sources again. In your next response call big_pi_compress using exactly one of these returned candidateIds: ${choices}. Write an evidence-aware summary meeting its minimum token target; prefer the recommended target.`;
    }
    if (discovery?.sourceType === "raw") {
      return "Raw discovery returned no eligible ranges. In your next response call big_pi_compression_sources with {\"sourceType\":\"blocks\",\"tier\":1}; if it returns no candidates, try tier 2, then yield if neither is eligible.";
    }
    if (discovery?.sourceType === "blocks" && discovery.tier === 1) {
      return "Tier-1 block discovery returned no promotion candidates. In your next response call big_pi_compression_sources with {\"sourceType\":\"blocks\",\"tier\":2}; if it also returns no candidates, stop compression and yield to Pi native compaction.";
    }
    if (discovery?.sourceType === "blocks" && discovery.tier === 2) {
      return "No raw or hierarchy candidate is eligible. Do not repeat source discovery. Stop compression and yield to Pi native compaction.";
    }
    return "In your next response call big_pi_compression_sources with {\"sourceType\":\"raw\"}. Choose one returned eligibleRanges[].candidateId, then on the following response call big_pi_compress with that exact ID and an evidence-aware summary meeting the candidate's minimumSummaryTokens. Do not repeat discovery after it returns candidates.";
  }

  function blockCompressionSources(current, tier) {
    if (!config.hierarchy.enabled || (tier !== 1 && tier !== 2)) return [];
    const applicableIds = current.applicability.applicableBlockIds;
    const positions = new Map(current.bindings.map((binding) => [binding.ref, binding.contextIndex]));
    const blocks = current.state.blocks
      .filter((block) => block.tier === tier && block.status === "active" && applicableIds.has(block.id))
      .map((block) => ({ block, refs: getEffectiveOriginalRefs(block) }))
      .sort((left, right) =>
        (positions.get(left.refs[0]) ?? Infinity) - (positions.get(right.refs[0]) ?? Infinity),
      );
    const ranges = [];
    let range = [];
    const finishRange = () => {
      const sourceCharCount = range.reduce((total, { block }) => total + block.summary.length, 0);
      if (
        range.length >= Math.max(2, config.hierarchy.minBlocksPerPromotion) &&
        sourceCharCount >= config.minCompressRangeChars
      ) {
        ranges.push(range);
      }
      range = [];
    };
    for (const item of blocks) {
      const firstPosition = positions.get(item.refs[0]);
      const previous = range.at(-1);
      const previousPosition = previous && positions.get(previous.refs.at(-1));
      if (previous && firstPosition !== previousPosition + 1) finishRange();
      range.push(item);
    }
    finishRange();
    return ranges.map((items) => {
      const sourceBlockIds = items.map(({ block }) => block.id);
      const sourceTokensEstimate = items.reduce((total, { block }) => total + block.summaryTokensEstimate, 0);
      const minimumSummary = minimumSummaryTokens(sourceTokensEstimate, config.minSummaryRetentionPercent);
      return {
        sourceType: "blocks",
        candidateId: compressionCandidateId(current, "blocks", [tier, ...sourceBlockIds]),
        tier,
        sourceBlockIds,
        sourceTokensEstimate,
        minimumSummaryTokens: minimumSummary,
        recommendedSummaryTokens: Math.max(minimumSummary + 32, Math.ceil(minimumSummary * 1.1)),
        originalSourceTokensEstimate: items.reduce((total, { block }) => total + block.originalSourceTokensEstimate, 0),
        effectiveOriginalMessageRefs: items.flatMap(({ refs }) => refs),
        blocks: items.map(({ block }) => ({
          id: block.id,
          tier: block.tier,
          originalMessageCount: block.effectiveOriginalMessageRefs.length,
          summaryTokensEstimate: block.summaryTokensEstimate,
          preview: block.summary.replace(/\s+/g, " ").trim().slice(0, SOURCE_PREVIEW_CHARS),
        })),
      };
    });
  }

  function emergencySourceIndex(current, sources) {
    const pressure = current.emergencyPressure;
    return {
      pressureState: currentEmergencyState(current),
      effectiveContextTokens: current.state.metrics.effectiveTransformedContextTokensEstimate,
      contextWindow: current.state.metrics.usableContextWindow,
      usedPercentage: pressure.usedPercentage,
      remainingPercentage: pressure.remainingPercentage,
      targetPercentage: config.emergency.targetPercentageAfterCompression,
      targetEffectiveTokens: pressure.targetEffectiveTokens,
      estimatedReclaimTokens: pressure.estimatedReclaimTokens,
      eligibleRangeCount: sources.length,
    };
  }

  function queueEmergencyCompression(current, attempt) {
    const guidance = emergencyGuidance(current, attempt, true);
    const runtime = emergencyRuntime(current);
    if (runtime.compressionFollowUpQueued) return false;
    runtime.compressionFollowUpQueued = true;
    try {
      pi.sendUserMessage(guidance, { deliverAs: "followUp" });
      return true;
    } catch (error) {
      runtime.compressionFollowUpQueued = false;
      throw error;
    }
  }

  function queueManualCompression(current, extraText = "") {
    const runtime = emergencyRuntime(current);
    if (runtime.compressionFollowUpQueued) return false;
    runtime.compressionFollowUpQueued = true;
    try {
      const request = `Please compress one completed, consumed work phase using big-pi. First discover candidates with big_pi_compression_sources. Choose one candidateId and pass it with your evidence-aware summary to big_pi_compress. Preserve user intent, decisions, paths, exact verification commands and observed results, failures, uncertainty, and open work. Distinguish files written from behavior verified; use NOT VERIFIED when output is absent. Aim for candidate.recommendedSummaryTokens, or choose a smaller coherent candidate. If validation fails, correct it in this turn; do not queue another request. Do not claim success unless big_pi_compress applies it. ${extraText}`.trim();
      pi.sendUserMessage(request, { deliverAs: "followUp" });
      return true;
    } catch (error) {
      runtime.compressionFollowUpQueued = false;
      throw error;
    }
  }

  function toolFailure(error, compression = false) {
    log("warning", `${compression ? "compression" : "source discovery"} tool rejected a request: ${error.message}`);
    let recovery = "Refresh big_pi_compression_sources for fresh values, choose one current candidateId, correct the request in this turn, and do not repeat identical invalid arguments.";
    const summaryMinimum = /minimum (\d+) tokens at ([\d.]+)%/.exec(error.message);
    const shortRange = /below the (\d+)-character minimum/.exec(error.message);
    if (summaryMinimum) {
      const minimum = Number(summaryMinimum[1]);
      const safeTarget = Math.max(minimum + 32, Math.ceil(minimum * 1.1));
      recovery = `The selected candidate requires at least ${minimum} estimated summary tokens (${summaryMinimum[2]}% retention); aim for ${safeTarget} or more to allow for estimation variance. Add concrete preserved facts, decisions, results, and open work, or select a smaller eligible candidate from a fresh source list. ${recovery}`;
    } else if (shortRange) {
      recovery = `The selected source has fewer than ${shortRange[1]} characters. Refresh the source list and select a single returned eligible contiguous range/candidate whose sourceChars meets that minimum. ${recovery}`;
    } else if (/unknown or reversed source range/i.test(error.message)) {
      recovery = `The refs are stale, unknown, or reversed. Refresh the source list and use the candidateId of one returned eligible range. ${recovery}`;
    }
    return {
      content: [{
        type: "text",
        text: compression
          ? `Compression not applied: ${error.message} Every call needs your non-empty summary and exactly one source form. ${recovery}`
          : `Source discovery failed: ${error.message}`,
      }],
      details: undefined,
      isError: true,
    };
  }

  function compressionArgumentError(params = {}) {
    const hasCandidate = typeof params.candidateId === "string" && params.candidateId.length > 0;
    const hasStart = typeof params.startRef === "string" && params.startRef.length > 0;
    const hasEnd = typeof params.endRef === "string" && params.endRef.length > 0;
    const hasBlocks = params.sourceBlockIds !== undefined;
    const hasAnyRawArgument = params.startRef !== undefined || params.endRef !== undefined;
    if (typeof params.summary !== "string" || !params.summary.trim()) {
      return "summary is required for every compression and must be written by the active agent";
    }
    if (hasCandidate && (hasBlocks || hasAnyRawArgument)) {
      return "candidateId is a complete source selection; do not combine it with refs or sourceBlockIds";
    }
    if (hasBlocks && hasAnyRawArgument) {
      return "choose exactly one source form: startRef plus endRef for raw compression, or sourceBlockIds for block promotion; do not mix them";
    }
    if (hasBlocks) {
      if (!Array.isArray(params.sourceBlockIds) || params.sourceBlockIds.length === 0) {
        return "sourceBlockIds must contain IDs returned by big_pi_compression_sources with sourceType=blocks and tier=1 or 2";
      }
      return null;
    }
    if (hasCandidate) return null;
    if (!hasCandidate && !hasStart && !hasEnd && !hasBlocks) {
      return "provide startRef and endRef from big_pi_compression_sources with sourceType=raw, or sourceBlockIds from sourceType=blocks";
    }
    if (!hasStart) {
      return "startRef is missing; call big_pi_compression_sources with sourceType=raw and use a returned eligible range";
    }
    if (!hasEnd) {
      return "endRef is missing; call big_pi_compression_sources with sourceType=raw and use a returned eligible range";
    }
    return null;
  }

  pi.registerTool({
    name: "big_pi_compression_sources",
    label: "Compression sources",
    description: "Discover eligible raw ranges or contiguous same-tier block promotion candidates with compact metadata and bounded previews.",
    promptSnippet: "Inspect eligible candidates, then use the returned candidateId for validated compression.",
    promptGuidelines: [COMPRESSION_GUIDANCE],
    parameters: {
      [typeBoxKind]: "Object",
      type: "object",
      properties: {
        sourceType: {
          [typeBoxKind]: "String",
          type: "string",
          enum: ["raw", "blocks"],
          description: "Use raw for ordinary Tier-1 compression; use blocks to inspect hierarchy promotion candidates.",
        },
        tier: {
          [typeBoxKind]: "Number",
          type: "integer",
          enum: [1, 2],
          description: "Required with sourceType=blocks: select Tier-1 sources for Tier-2 or Tier-2 sources for Tier-3.",
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params = {}, _signal, _onUpdate, ctx) {
      try {
        const current = refresh(ctx);
        if (params.sourceType === "blocks") {
          const tier = params.tier;
          if (tier !== 1 && tier !== 2) throw new Error("Block source discovery requires tier 1 or 2");
          const candidates = blockCompressionSources(current, tier);
          rememberCompressionCandidates(current, candidates, "blocks", tier);
          debugEvent(current.sessionPath, "compression_sources_discovered", { sourceType: "blocks", tier, candidateCount: candidates.length });
          log("info", `[hierarchy] candidate tier${tier} blocks=${candidates.map((range) => range.sourceBlockIds.join("..")).join(";") || "none"}`);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                sourceType: "blocks",
                sourceTier: tier,
                targetTier: tier + 1,
                minimumBlocks: Math.max(2, config.hierarchy.minBlocksPerPromotion),
                candidates,
                candidateInstructions: "Choose one candidateId and pass it to big_pi_compress; do not copy block IDs when using candidateId.",
                limitation: tier === 2 && !candidates.length
                  ? "No contiguous applicable Tier-2 run meets the promotion minimum; Tier-3 is the highest supported tier."
                  : undefined,
              }),
            }],
            details: undefined,
          };
        }
        if (params.sourceType !== undefined && params.sourceType !== "raw") {
          throw new Error("sourceType must be raw or blocks");
        }
        const sources = compressionSources(current);
        rememberCompressionCandidates(current, sources);
        debugEvent(current.sessionPath, "compression_sources_discovered", { sourceType: "raw", candidateCount: sources.length });
        return {
          content: [{
            type: "text",
            text: sources.length
              ? JSON.stringify({
                minCompressRangeChars: config.minCompressRangeChars,
                minSummaryRetentionPercent: config.minSummaryRetentionPercent,
                candidateInstructions: "Choose one candidateId and pass it to big_pi_compress; do not copy refs when using candidateId.",
                emergency: emergencySourceIndex(current, sources),
                eligibleRanges: sources,
              })
              : JSON.stringify({
                emergency: emergencySourceIndex(current, sources),
                eligibleRanges: [],
                limitation: current.state.metrics.activeBlockCount > 0
                  ? "No safe uncovered raw range meets the minimum. Discover hierarchy promotion candidates with sourceType=blocks and tier=1 or tier=2 if summary mass justifies it."
                  : "No safe uncovered, unprotected source range meets the minimum compression size.",
              }),
          }],
          details: undefined,
        };
      } catch (error) {
        let sessionPath;
        try { sessionPath = getSessionPath(ctx); } catch { sessionPath = undefined; }
        debugEvent(sessionPath, "compression_sources_failed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
          category: debugFailureCategory(error),
        });
        if (error instanceof StateIntegrityError) rememberIntegrityFailure(ctx, error);
        return toolFailure(error);
      }
    },
  });

  pi.registerTool({
    name: "big_pi_compress",
    label: "Compress context",
    description: "Apply one model-selected candidate. Always provide your own non-empty summary and preferably the candidateId from a current big_pi_compression_sources result. Legacy startRef/endRef and sourceBlockIds forms remain accepted. The tool independently enforces protection, eligibility, provenance, and context-reduction rules.",
    promptSnippet: "Apply a returned candidateId with an agent-written high-fidelity summary.",
    promptGuidelines: [COMPRESSION_GUIDANCE],
    parameters: compressionParameters,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      let rollbackState;
      let phaseCurrent;
      let phaseTracked = false;
      try {
        phaseCurrent = refresh(ctx, false);
        const phase = compressionPhases.get(phaseKey(phaseCurrent));
        if (phase) {
          phase.compressionAttempts++;
          phaseTracked = true;
          debugEvent(phaseCurrent.sessionPath, "compression_call_started", {
            toolCallId,
            attempt: phase.compressionAttempts,
            request: phase.requests,
          });
        }
        const argumentError = compressionArgumentError(params);
        if (argumentError) throw new Error(argumentError);
        const current = refresh(ctx, false);
        rollbackState = structuredClone(current.state);
        let block;
        let sourceBlockIds = params.sourceBlockIds;
        let startRef = params.startRef;
        let endRef = params.endRef;
        if (params.candidateId) {
          const cachedCandidate = issuedCompressionCandidates.get(candidateCacheKey(current, params.candidateId));
          const rawCandidate = compressionSources(current).find((candidate) => candidate.candidateId === params.candidateId) ??
            (cachedCandidate?.sourceType === "raw" ? cachedCandidate : undefined);
          if (rawCandidate) {
            startRef = rawCandidate.startRef;
            endRef = rawCandidate.endRef;
          } else {
            const blockCandidate = [1, 2]
              .flatMap((tier) => blockCompressionSources(current, tier))
              .find((candidate) => candidate.candidateId === params.candidateId) ??
              (cachedCandidate?.sourceType === "blocks" ? cachedCandidate : undefined);
            if (!blockCandidate) throw new Error("candidate is stale or no longer eligible; refresh big_pi_compression_sources and choose a current candidateId");
            sourceBlockIds = blockCandidate.sourceBlockIds;
          }
        }
        if (Array.isArray(sourceBlockIds)) {
          if (params.startRef !== undefined || params.endRef !== undefined) {
            throw new Error("Do not mix raw source refs with sourceBlockIds");
          }
          block = createHierarchicalBlock(
            current.state,
            current.bindings,
            sourceBlockIds,
            params.summary,
            config.hierarchy,
            config.minCompressRangeChars,
            current.protectedRegion.refs,
            current.projection.messages,
            config.minSummaryRetentionPercent,
          );
        } else {
          if (typeof startRef !== "string" || typeof endRef !== "string") {
            throw new Error("Raw compression requires both startRef and endRef from one eligible range returned by big_pi_compression_sources with sourceType=raw");
          }
          block = applyCompression(
            current.state,
            current.bindings,
            current.protectedRegion.refs,
            startRef,
            endRef,
            params.summary,
            config.minCompressRangeChars,
            current.projection.messages,
            config.minSummaryRetentionPercent,
          );
        }
        persistCompression(current, ctx, block);
        endCompressionPhase(current, "committed");
        debugEvent(current.sessionPath, "compression_applied", {
          toolCallId,
          tier: block.tier,
          sourceMessageCount: block.sourceMessageCount,
          sourceCharCount: block.sourceCharCount,
        });
        debugEvent(current.sessionPath, "compression_call_completed", { toolCallId, blockId: block.id, tier: block.tier });
        return {
          content: [{
            type: "text",
            text: `Compression applied as ${block.id} (tier ${block.tier}): ${block.sourceMessageCount} original messages, ${block.sourceCharCount} source characters.`,
          }],
          details: undefined,
        };
      } catch (error) {
        let sessionPath;
        try { sessionPath = getSessionPath(ctx); } catch { sessionPath = undefined; }
        debugEvent(sessionPath, "compression_failed", {
          toolCallId,
          errorType: error instanceof Error ? error.name : "UnknownError",
          category: debugFailureCategory(error),
        });
        if (phaseTracked && phaseCurrent) {
          const phase = compressionPhases.get(phaseKey(phaseCurrent));
          if (phase) phase.failedAttempts++;
          if (phase) phase.lastFailure = error instanceof Error ? error.message.slice(0, 320) : "Compression call failed";
          debugEvent(sessionPath, "compression_call_failed", {
            toolCallId,
            category: debugFailureCategory(error),
            attempt: phase?.compressionAttempts ?? null,
            failedAttempts: phase?.failedAttempts ?? null,
          });
        }
        if (rollbackState) state = rollbackState;
        if (error instanceof StateIntegrityError) rememberIntegrityFailure(ctx, error);
        return toolFailure(error, true);
      }
    },
  });

  async function command(args, ctx) {
    const [subcommand = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
    try {
      const current = refresh(ctx);
      switch (subcommand) {
        case "status": {
          const m = current.state.metrics;
          const ownership = compactionOwnership(ctx);
          const nativeDiagnostics = diagnosticsFor(current.sessionPath);
          const recovery = emergencyRuntime(current);
          const emergency = emergencyRecord(current);
          const pressure = emergencyPressure(current);
          const ownsCompaction = ownership.owns && !piOwnsCompaction(recovery);
          const number = (value) => Number(value ?? 0).toLocaleString("en-US");
          const percent = (value) => value === null || value === undefined ? "unavailable" : `${value.toFixed(1)}%`;
          const budgetDelta = m.contextBudgetDeltaTokens;
          ctx.ui.notify([
            `big-pi ${VERSION} (schema ${SCHEMA_VERSION})`,
            `Agent ID: ${agentId ?? "default"}`,
            `State: ${ownership.owns ? "active" : "degraded"}`,
            `Compaction owner: ${ownsCompaction ? "big-pi" : "Pi"}`,
            `Pi native compaction: ${ownsCompaction
              ? nativeDiagnostics.attempts && nativeDiagnostics.lastResult === "cancelled"
                ? "intercepted"
                : `interception active (${nativeDiagnostics.lastResult})`
              : "allowed"}`,
            `Native compact attempts: ${nativeDiagnostics.attempts}`,
            `Native compactions cancelled: ${nativeDiagnostics.cancelled}`,
            `Last native compact attempt: ${nativeDiagnostics.lastAttemptAt ?? "never"}`,
            `Last native compact reason: ${nativeDiagnostics.lastReason ?? "never"}`,
            `Last interception result: ${nativeDiagnostics.lastResult}`,
            ...(ownsCompaction ? [] : [`Reason: ${piOwnsCompaction(recovery)
              ? emergency.lastReason ?? "big-pi emergency recovery yielded ownership"
              : ownership.reason}`]),
            `Emergency handling: ${config.emergency.enabled ? "enabled" : "disabled"}`,
            `Pressure threshold: ${config.emergency.pressureThresholdPercentage}%`,
            `Target after compression: ${config.emergency.targetPercentageAfterCompression}%`,
            `Current pressure state: ${currentEmergencyState(current, recovery)}`,
            `Reclaim needed from latest provider usage: ${pressure.estimatedReclaimTokens === null ? "unavailable" : `${number(pressure.estimatedReclaimTokens)} tokens`}`,
            `Last pressure: ${emergency.lastPressureAt ?? "none"}`,
            `Last overflow: ${emergency.lastOverflowAt ?? "none"}`,
            `Last overflow reason: ${emergency.lastOverflowReason ?? "none"}`,
            `Last emergency outcome: ${emergency.lastOutcome}`,
            `Native fallback state: ${recovery.nativeFallbackState}`,
            `Recovery state: ${piOwnsCompaction(recovery)
              ? recovery.interrupted ? "interrupted; Pi owns compaction"
                : recovery.nativeFallbackState === "failed" ? "Pi fallback failed; Pi owns compaction"
                  : "Pi fallback pending; Pi owns compaction"
              : recovery.active ? `active (${Math.min(recovery.attempts, config.emergency.maxAttemptsPerTurn)} / ${config.emergency.maxAttemptsPerTurn} attempts)`
                : recovery.nativeFallbackState === "completed" ? "Pi fallback completed; big-pi ownership resumed"
                  : emergency.lastOutcome === "recovered" ? "recovered" : emergency.lastOutcome}`,
            ...(emergency.lastReason ? [`Recovery reason: ${emergency.lastReason}`] : []),
            `Historical Pi compaction: ${historicalCompactionStatus(ctx)}`,
            `Projected original/raw context: ${m.projectedModelContextMessages} messages; ~${number(m.projectedOriginalRawContextTokensEstimate)} estimated tokens`,
            `Compression-eligible raw: ${m.compressionEligibleRawMessages} messages; ~${m.compressionEligibleRawTokensEstimate} estimated tokens`,
            `Active raw messages: ${m.activeRawMessages}; applicable blocks: ${m.activeBlockCount}/${m.totalBlockCount}; covered sources: ${m.coveredSourceMessages}`,
            `Historical blocks: ${m.totalBlockCount}; active applicable representations: ${m.activeApplicableBlockCount}`,
            ...m.hierarchy.map((tier) =>
              `Tier-${tier.tier} active blocks: ${tier.activeBlockCount}; summary tokens: ~${number(tier.summaryTokensEstimate)}`,
            ),
            `Tier-2 promotion due: ${m.tier2PromotionDue ? "yes" : "no"} (threshold ~${number(config.hierarchy.tier2NudgeSummaryTokens)} tokens)`,
            `Tier-3 promotion due: ${m.tier3PromotionDue ? "yes" : "no"} (threshold ~${number(config.hierarchy.tier3NudgeSummaryTokens)} tokens)`,
            `Hierarchy enabled: ${config.hierarchy.enabled}; minimum promotion blocks: ${config.hierarchy.minBlocksPerPromotion}`,
            `Inapplicable blocks: ${m.inapplicableBlockCount} (source absent: ${m.sourceMissingBlockCount}, source mismatch: ${m.sourceMismatchBlockCount}, non-contiguous: ${m.nonContiguousBlockCount})`,
            `Original tokens represented by applicable blocks: ~${number(m.sourceTokensRepresentedByApplicableBlocks)}`,
            `Applicable blocks' direct-source token mass: ~${number(m.applicableBlockDirectSourceTokensEstimate)}`,
            `Current block-summary tokens: ~${number(m.blockSummaryTokensEstimate)}`,
            `Effective transformed context: ~${number(m.effectiveTransformedContextTokensEstimate)}`,
            `Protected: ${m.protectedMessageCount} messages; ~${m.protectedTokenEstimate} estimated tokens`,
            `Provider-reported prompt usage: ${m.piContextUsageTokens ?? "unavailable"} tokens / ${m.usableContextWindow ?? m.piContextWindow ?? "unknown"} window`,
            `Nudge mode: ${config.nudge.mode}`,
            `Growth trigger: ${number(config.nudge.growthTriggerTokens)} tokens`,
            `Percentage threshold: ${config.nudge.thresholdPercentage}%`,
            `Percentage repeat interval: ${config.nudge.repeatEveryPercentage}%`,
            `Percentage display: ${config.nudge.display}`,
            `Percentage status: ${m.percentageStatus}`,
            ...(m.percentageStatus === "unavailable" ? [`Reason: ${m.percentageUnavailableReason}`] : []),
            `Effective context: ${number(m.effectiveTransformedContextTokensEstimate)} tokens`,
            `Raw/model context window: ${m.piContextWindow ?? m.usableContextWindow ?? "unavailable"}`,
            `Usable context window: ${m.usableContextWindow === null ? "unavailable" : `${number(m.usableContextWindow)} tokens (Pi-reported nominal model contextWindow; no separate reserve-adjusted limit exposed)`}`,
            `Context used: ${percent(m.currentUsedPercentage)}`,
            `Context remaining: ${percent(m.currentRemainingPercentage)}`,
            `Over/under budget: ${budgetDelta === null ? "unavailable" : budgetDelta < 0 ? `${number(-budgetDelta)} tokens over budget` : `${number(budgetDelta)} tokens remaining`}`,
            `Last percentage checkpoint: ${m.percentageLastDeliveredCheckpoint === null ? "never" : `${m.percentageLastDeliveredCheckpoint}%`}`,
            `Next percentage checkpoint: ${m.percentageNextCheckpoint === null ? "unavailable" : `${m.percentageNextCheckpoint}%`}`,
            `Last percentage nudge: ${m.percentageLastNudgeAt ?? "never"}`,
            `Percentage nudge due: ${m.percentageNudgeDue ? "yes" : "no"}`,
            `Growth nudge due: ${m.growthNudgeDue ? "yes" : "no"}`,
            `Current provider-measured baseline: ${m.growthMeasurementAvailable ? `${number(m.growthBaselineEffectiveTokens)} tokens` : "unavailable"}`,
            `Provider-measured growth since baseline: ${m.growthMeasurementAvailable ? `${number(m.growthSinceBaselineTokens)} tokens` : "unavailable"}`,
            `Next nudge at: ${m.growthMeasurementAvailable ? `${number(m.nextNudgeAtGrowthTokens)} provider-measured growth tokens` : "unavailable"}`,
            `Nudge due: ${m.nudgeDue ? "yes" : "no"}`,
            `Last nudge: ${m.lastNudgeAt ? `${m.lastNudgeAt} at ${number(m.lastNudgeGrowthTokens)} provider-measured growth tokens` : "never"}`,
            `Last successful compression: ${m.lastSuccessfulCompressionAt ?? "never"}${
              m.lastSuccessfulCompressionEffectiveTokens === null || m.lastSuccessfulCompressionEffectiveTokens === undefined
                ? ""
                : ` (~${number(m.lastSuccessfulCompressionEffectiveTokens)} estimated effective-context tokens)`
            }`,
            `Minimum compression range: ${config.minCompressRangeChars} source characters`,
            `Stale blocks: ${m.staleBlockCount}; last compression: ${m.lastCompressionAt ?? "never"} (${m.lastCompressionResult})`,
            `Storage folder: ${path.dirname(current.sidecar)}`,
            `Manifest: ${current.sidecar}`,
            `Committed chunks: ${current.state.blocks.length} (including dormant, superseded, and damaged); disk usage: ${storageDiskUsage(current.sessionPath, agentId)} bytes`,
            "Pi-native compaction does not create Big Pi chunks; chunks count successful big_pi_compress calls.",
            ...(current.state.blocks.some((block) => block.storageError)
              ? [`Damaged committed chunks: ${current.state.blocks.filter((block) => block.storageError).map((block) => block.id).join(", ")}`]
              : []),
            `Config: ${configPath}`,
          ].join("\n"), "info");
          break;
        }
        case "compact":
          {
            const runtime = emergencyRuntime(current);
            if (runtime.compressionFollowUpQueued) {
              ctx.ui.notify("A Big Pi compression turn is already queued for this session; it will run before another one is queued.", "info");
              break;
            }
            runtime.compressionFollowUpQueued = true;
            try {
              pi.sendUserMessage(
                `Please compress one completed, consumed work phase using big-pi. First discover sources with big_pi_compression_sources. For raw Tier-1 use startRef and endRef from one returned eligible range; for hierarchy promotion use sourceBlockIds from one returned contiguous candidate of one tier. Write an evidence-aware summary that keeps user intent, decisions, paths, exact verification commands and observed results, failures, uncertainty, and open work. Distinguish files written from behavior verified; use NOT VERIFIED when output is absent. Meet the candidate's minimumSummaryTokens, or choose smaller coherent ranges. If validation fails, correct it in this turn; do not queue another request. Do not claim success unless big_pi_compress applies it. ${rest.join(" ")}`.trim(),
                { deliverAs: "followUp" },
              );
            } catch (error) {
              runtime.compressionFollowUpQueued = false;
              throw error;
            }
            ctx.ui.notify("Queued an active-agent compression turn. The active model will choose a range and summary.", "info");
          }
          break;
        case "blocks": {
          const blocks = current.state.blocks;
          const number = (value) => Number(value ?? 0).toLocaleString("en-US");
          ctx.ui.notify(blocks.length ? blocks.map((block) =>
            `${block.id} T${block.tier} chunk=${block._storageIndex?.chunkPath ?? "uncommitted"} children=${block.sourceBlockIds.length} originals=${block.effectiveOriginalMessageRefs.length} ` +
            `${block.sourceRefRange.start}..${block.sourceRefRange.end} ` +
            `(raw≈${number(block.originalSourceTokensEstimate)} direct≈${number(block.sourceTokensEstimate)} summary≈${number(block.summaryTokensEstimate)} tokens) ` +
            `${block.createdAt} ${block.status}` +
            (block.supersededByBlockId ? ` superseded-by=${block.supersededByBlockId}` : "") +
            (block.storageError ? ` (DAMAGED: ${block.storageError})` : "") +
            (current.applicability.skippedBlockReasons.has(block.id)
              ? ` (${current.applicability.skippedBlockReasons.get(block.id)})`
              : ""),
          ).join("\n") : "No compression blocks.", "info");
          break;
        }
        case "inspect": {
          const id = rest[0];
          const block = current.state.blocks.find((item) => item.id === id);
          if (!block) throw new Error(`No block found with ID ${id ?? "(missing)"}`);
          ctx.ui.notify(JSON.stringify({
            id: block.id,
            tier: block.tier,
            chunkPath: block._storageIndex?.chunkPath ?? null,
            chunkIntegrity: block.storageError ? `damaged: ${block.storageError}` : "valid",
            committed: Boolean(block._storageIndex),
            createdAt: block.createdAt,
            status: block.status,
            directSourceBlockIds: block.sourceBlockIds,
            transitiveOriginalMessageRefs: block.effectiveOriginalMessageRefs,
            supersedesBlockIds: block.supersedesBlockIds,
            supersededByBlockId: block.supersededByBlockId,
            currentProjectionApplicable: current.applicability.applicableBlockIds.has(block.id),
            currentProjectionReason: current.applicability.skippedBlockReasons.get(block.id) ?? null,
            directSourceTokensEstimate: block.sourceTokensEstimate,
            originalSourceTokensRepresentedEstimate: block.originalSourceTokensEstimate,
            summaryTokensEstimate: block.summaryTokensEstimate,
            summary: block.summary,
          }, null, 2), "info");
          break;
        }
        case "dump-context": {
          if (!config.contextDumpEnabled) throw new Error("Context dumps are disabled by config");
          const dumpDir = process.env.BIG_PI_DUMP_DIR
            ? path.resolve(process.env.BIG_PI_DUMP_DIR)
            : path.join(os.homedir(), ".pi", "big-pi-dumps");
          mkdirSync(dumpDir, { recursive: true });
          const filename = `${path.basename(current.sessionPath)}.${Date.now()}.txt`;
          const dumpPath = path.join(dumpDir, filename);
          writeFileSync(
            dumpPath,
            renderContextDump(
              current.projection.messages,
              current.bindings,
              current.state.blocks,
              current.protectedRegion.refs,
              {
                manifestPath: current.sidecar,
                committedChunkCount: current.state.blocks.length,
                diskUsageBytes: storageDiskUsage(current.sessionPath, agentId),
                damagedBlocks: current.state.blocks
                  .filter((block) => block.storageError)
                  .map((block) => ({ blockId: block.id, reason: block.storageError })),
              },
            ),
            { mode: 0o600 },
          );
          ctx.ui.notify(`Wrote logical model-context dump to ${dumpPath}. It may contain sensitive session content.`, "info");
          break;
        }
        default:
          throw new Error("Usage: /big-pi [status|compact|blocks|inspect <block-id>|dump-context]");
      }
      log("debug", `context raw=${current.state.metrics.projectedModelContextTokensEstimate} effective=${current.state.metrics.effectiveTransformedContextTokensEstimate} messages=${current.transformed.length}`);
    } catch (error) {
      if (error instanceof StateIntegrityError) rememberIntegrityFailure(ctx, error);
      if (subcommand === "status") {
        let sessionPath;
        try {
          sessionPath = getSessionPath(ctx);
        } catch {
          sessionPath = undefined;
        }
        const diagnostics = diagnosticsFor(sessionPath);
        const reason = disabledSessionPath === sessionPath
          ? disabledSessionReason
          : error.message || "big-pi state could not be validated";
        ctx.ui.notify([
          `big-pi ${VERSION} (schema ${SCHEMA_VERSION})`,
          `State: ${error instanceof StateIntegrityError ? "degraded" : "unavailable"}`,
          "Compaction owner: Pi",
          "Pi native compaction: allowed",
          `Native compact attempts: ${diagnostics.attempts}`,
          `Native compactions cancelled: ${diagnostics.cancelled}`,
          `Last native compact attempt: ${diagnostics.lastAttemptAt ?? "never"}`,
          `Last native compact reason: ${diagnostics.lastReason ?? "never"}`,
          `Last interception result: ${diagnostics.lastResult}`,
          `Reason: ${reason}`,
          `Manifest: ${sessionPath ? sidecarPath(sessionPath, agentId) : "unavailable"}`,
        ].join("\n"), "info");
        return;
      }
      warnUser(ctx, `${error.message}. Original Pi session transcript was not modified.`);
    }
  }

  pi.registerCommand("big-pi", {
    description: "Inspect context state or queue active-agent compression",
    handler: command,
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const current = refresh(ctx);
      debugEvent(current.sessionPath, "session_start", { version: VERSION });
      disabledSessionPath = undefined;
      disabledSessionReason = undefined;
      log("info", `big-pi ${VERSION} active for ${current.sessionPath}`);
    } catch (error) {
      if (error instanceof StateIntegrityError) rememberIntegrityFailure(ctx, error);
      warnUser(ctx, `Unable to initialize session state; context will remain unmodified: ${error.message}`);
    }
  });

  pi.on("session_before_compact", (event, ctx) => {
    let sessionPath;
    try {
      sessionPath = getSessionPath(ctx);
    } catch {
      sessionPath = undefined;
    }
    const diagnostics = diagnosticsFor(sessionPath);
    diagnostics.attempts++;
    diagnostics.lastAttemptAt = new Date().toISOString();
    diagnostics.lastReason = event.reason;
    debugEvent(sessionPath, "compaction_requested", {
      reason: ["manual", "threshold", "overflow"].includes(event.reason) ? event.reason : "unknown",
      willRetry: event.willRetry === true,
    });
    log("info", `[compaction] Pi native compaction requested reason=${event.reason} willRetry=${event.willRetry}`);

    const ownership = compactionOwnership(ctx);
    if (!ownership.owns) {
      diagnostics.lastResult = "allowed";
      debugEvent(sessionPath, "native_compaction_allowed", { reason: "big_pi_unavailable" });
      log("warning", `[compaction] allowed; big-pi state unavailable reason=${ownership.reason}`);
      return;
    }

    if (event.reason === "manual") {
      try {
        const current = refresh(ctx);
        const queued = queueManualCompression(current);
        diagnostics.lastResult = queued
          ? "cancelled; Big Pi compression queued"
          : "cancelled; Big Pi compression already queued";
        diagnostics.cancelled++;
        if (queued) {
          log("info", "[compaction] routed user compact request to Big Pi compression");
          try { ctx.ui.notify("Queued a normal Big Pi compression turn for the active task.", "info"); } catch {}
        }
        return { cancel: true };
      } catch (error) {
        diagnostics.lastResult = "allowed; Big Pi could not queue manual compression";
        log("warning", `[compaction] could not route manual request to Big Pi reason=${error.message}`);
        return;
      }
    }

    if (event.reason === "overflow") {
      let current;
      try {
        current = refresh(ctx);
      } catch (error) {
        diagnostics.lastResult = "allowed";
        log("warning", `[emergency] could not safely prepare overflow recovery; yielding to Pi reason=${error.message}`);
        return;
      }
      const runtime = emergencyRuntime(current);
      const at = new Date().toISOString();
      const pressure = emergencyPressure(current);
      const overflowRecord = emergencyRecord(current);
      overflowRecord.lastOverflowAt = at;
      overflowRecord.lastOverflowReason = "Pi overflow";
      log("warning", "[emergency] overflow signaled by Pi");

      const yieldToPi = (reason) => {
        runtime.active = true;
        runtime.overflowActive = true;
        runtime.nativeFallbackState = "pending";
        runtime.activeEpisode = "overflow";
        runtime.attempts = config.emergency.maxAttemptsPerTurn;
        runtime.lastAttemptEffectiveTokens = current.state.metrics.piContextUsageTokens;
        try {
          persistEmergency(current, {
            lastOutcome: "fallback-pending",
            nativeFallbackState: "pending",
            activeEpisode: "overflow",
            lastEstimatedReclaimTokens: pressure.estimatedReclaimTokens,
            lastReason: reason,
            lastOverflowAt: at,
            lastOverflowReason: "Pi overflow",
          });
        } catch (error) {
          log("error", `[emergency] could not persist fallback diagnostics: ${error.message}`);
        }
        diagnostics.lastResult = "yielded to Pi";
        debugEvent(sessionPath, "emergency_yielded_to_pi", {
          reason: reason === "emergency handling is disabled" ? "disabled" : "recovery_unavailable",
          attempt: runtime.attempts,
        });
        log("warning", `[emergency] ${reason}; yielding to Pi native compaction`);
        try {
          ctx.ui.notify(
            `big-pi yielded this overflow to Pi native compaction: ${reason}. Pi will continue the active task from retained context after compaction.`,
            "warning",
          );
        } catch {
          // Fail-open behavior must not depend on UI availability.
        }
      };

      if (piOwnsCompaction(runtime)) {
        diagnostics.lastResult = "allowed";
        debugEvent(sessionPath, "native_fallback_already_owned", { attempt: runtime.attempts });
        try {
          persistEmergency(current, {
            lastOutcome: runtime.interrupted ? "interrupted" : overflowRecord.lastOutcome,
            nativeFallbackState: runtime.nativeFallbackState,
            activeEpisode: runtime.activeEpisode,
            lastEstimatedReclaimTokens: pressure.estimatedReclaimTokens,
            lastReason: runtime.interrupted
              ? overflowRecord.lastReason
              : overflowRecord.lastReason ?? "Pi owns emergency fallback",
            lastOverflowAt: at,
            lastOverflowReason: "Pi overflow",
          });
        } catch (error) {
          log("error", `[emergency] could not persist repeated-fallback diagnostics: ${error.message}`);
        }
        log("warning", "[emergency] Pi already owns fallback; allowing native overflow compaction");
        return;
      }
      if (runtime.compressionFollowUpQueued) {
        runtime.active = true;
        runtime.overflowActive = true;
        runtime.activeEpisode = "overflow";
        runtime.attempts = Math.max(runtime.attempts, 1);
        runtime.lastAttemptEffectiveTokens = current.state.metrics.piContextUsageTokens;
        diagnostics.lastResult = "cancelled duplicate overflow; recovery follow-up already queued";
        diagnostics.cancelled++;
        debugEvent(sessionPath, "duplicate_overflow_suppressed", { attempt: runtime.attempts });
        try {
          persistEmergency(current, {
            lastOutcome: "requested",
            nativeFallbackState: "none",
            activeEpisode: "overflow",
            lastEstimatedReclaimTokens: pressure.estimatedReclaimTokens,
            lastReason: null,
            lastOverflowAt: at,
            lastOverflowReason: "Pi overflow",
          });
        } catch (error) {
          log("error", `[emergency] unable to persist queued recovery state reason=${error.message}`);
        }
        log("warning", "[emergency] duplicate overflow event cancelled; one recovery follow-up is already queued for this session");
        return { cancel: true };
      }
      if (!config.emergency.enabled) {
        yieldToPi("emergency handling is disabled");
        return;
      }
      if (runtime.attempts >= config.emergency.maxAttemptsPerTurn) {
        const previousFailure = overflowRecord.lastOutcome === "failed" && overflowRecord.lastReason;
        yieldToPi(previousFailure ||
          `emergency attempts exhausted (${config.emergency.maxAttemptsPerTurn} / ${config.emergency.maxAttemptsPerTurn})`);
        return;
      }
      const sources = compressionSources(current);
      const tier1Promotions = !sources.length && config.hierarchy.enabled ? blockCompressionSources(current, 1) : [];
      const tier2Promotions = !sources.length && !tier1Promotions.length && config.hierarchy.enabled
        ? blockCompressionSources(current, 2)
        : [];
      if (!sources.length && !tier1Promotions.length && !tier2Promotions.length) {
        const reason = current.state.metrics.activeBlockCount > 0
          ? "no safe uncovered range or qualified hierarchy promotion exists"
          : "no safe eligible range exists (protected/recent context and minimum range rules preserved)";
        yieldToPi(reason);
        debugEvent(sessionPath, "emergency_no_eligible_sources");
        log("warning", "[emergency] no safe eligible range exists");
        return;
      }

      const attempt = runtime.attempts + 1;
      runtime.attempts = attempt;
      runtime.active = true;
      runtime.overflowActive = true;
      runtime.activeEpisode = "overflow";
      runtime.lastAttemptEffectiveTokens = current.state.metrics.piContextUsageTokens;
      try {
        persistEmergency(current, {
          lastOutcome: "requested",
          activeEpisode: "overflow",
          nativeFallbackState: "none",
          lastEstimatedReclaimTokens: pressure.estimatedReclaimTokens,
          lastReason: null,
          lastOverflowAt: at,
          lastOverflowReason: "Pi overflow",
        });
      } catch (error) {
        yieldToPi(`unable to persist emergency attempt: ${error.message}`);
        return;
      }
      log("info", `[emergency] attempt=${attempt}/${config.emergency.maxAttemptsPerTurn}`);
      debugEvent(sessionPath, "emergency_attempt_queued", {
        attempt,
        maxAttempts: config.emergency.maxAttemptsPerTurn,
        sourceType: sources.length ? "raw" : "blocks",
        candidateCount: sources.length || tier1Promotions.length || tier2Promotions.length,
      });
      try {
        queueEmergencyCompression(current, attempt);
      } catch (error) {
        yieldToPi(`unable to queue active-agent recovery: ${error.message}`);
        return;
      }
      diagnostics.cancelled++;
      diagnostics.lastResult = "cancelled for big-pi emergency recovery";
      debugEvent(sessionPath, "overflow_compaction_cancelled_for_big_pi", { attempt });
      log("info", "[compaction] cancelled; owner=big-pi emergency recovery");
      try {
        ctx.ui.notify(
          "big-pi queued emergency compression and cancelled this Pi overflow compaction. The active agent will compress eligible history, then continue the active task from retained context without asking whether to proceed.",
          "warning",
        );
      } catch {
        // Emergency recovery must not depend on UI availability.
      }
      return { cancel: true };
    }

    let current;
    try {
      current = refresh(ctx);
    } catch (error) {
      diagnostics.lastResult = "allowed";
      log("warning", `[compaction] allowed; state refresh failed open reason=${error.message}`);
      return;
    }
    const runtime = emergencyRuntime(current);
    if (piOwnsCompaction(runtime)) {
      diagnostics.lastResult = "allowed (emergency fallback)";
      log("warning", `[compaction] allowed; Pi owns emergency fallback reason=${emergencyRecord(current).lastReason ?? "recovery exhausted"}`);
      return;
    }

    if (event.reason === "threshold" && !compressionPhases.has(phaseKey(current)) && !runtime.active) {
      const key = phaseKey(current);
      const previous = thresholdInterceptions.get(key);
      if (previous) {
        if (previous.pendingNudge && !previous.nudgeDelivered && previous.interceptions < 2) {
          previous.interceptions++;
          thresholdInterceptions.set(key, previous);
          debugEvent(sessionPath, "threshold_interception_extended_for_nudge", {
            contextTokens: current.state.metrics.piContextUsageTokens,
            checkpointPercentage: previous.nudgeCheckpoint,
            interceptionCount: previous.interceptions,
          });
          log("info", `[compaction] allowing one additional threshold interception so the pending ${previous.nudgeCheckpoint}% advisory can reach the agent`);
        } else {
          thresholdInterceptions.delete(key);
          runtime.active = true;
          runtime.nativeFallbackState = "pending";
          runtime.activeEpisode = "pressure";
          diagnostics.lastResult = "yielded to Pi after repeated threshold without compression";
          try {
            persistEmergency(current, {
              lastOutcome: "fallback-pending",
              nativeFallbackState: "pending",
              activeEpisode: "pressure",
              lastReason: "Repeated Pi threshold compaction arrived without a committed Big Pi block",
            });
          } catch (error) {
            log("warning", `[compaction] could not persist repeated-threshold fallback reason=${error.message}`);
          }
          debugEvent(sessionPath, "threshold_compaction_yielded_after_repeat", {
            previousContextTokens: previous.contextTokens,
            currentContextTokens: current.state.metrics.piContextUsageTokens,
          });
          log("warning", "[compaction] yielding repeated Pi threshold request; Big Pi has not committed compression");
          return;
        }
      }
      if (!previous) {
        const metrics = current.state.metrics;
        const checkpoint = metrics.percentageNextCheckpoint;
        let liveUsage;
        try { liveUsage = ctx.getContextUsage?.(); } catch { liveUsage = undefined; }
        const thresholdUsedPercentage = metrics.currentUsedPercentage ?? (
          Number.isSafeInteger(liveUsage?.tokens) && liveUsage.tokens >= 0 &&
          Number.isSafeInteger(liveUsage?.contextWindow) && liveUsage.contextWindow > 0
            ? liveUsage.tokens / liveUsage.contextWindow * 100
            : Number.isSafeInteger(metrics.piContextUsageTokens) &&
              Number.isSafeInteger(metrics.usableContextWindow) && metrics.usableContextWindow > 0
              ? metrics.piContextUsageTokens / metrics.usableContextWindow * 100
              : null
        );
        const distanceToCheckpoint = thresholdUsedPercentage === null
          ? null
          : checkpoint - thresholdUsedPercentage;
        const pendingNudge = config.nudge.mode !== "growth" &&
          !metrics.percentageNudgeDue &&
          (metrics.percentageStatus === "available" ||
            (Number.isSafeInteger(liveUsage?.tokens) && liveUsage.tokens >= 0 &&
              Number.isSafeInteger(liveUsage?.contextWindow) && liveUsage.contextWindow > 0)) &&
          distanceToCheckpoint !== null && distanceToCheckpoint >= 0 && distanceToCheckpoint <= 1;
        thresholdInterceptions.set(key, {
          contextTokens: metrics.piContextUsageTokens,
          interceptions: 1,
          pendingNudge,
          nudgeCheckpoint: pendingNudge ? checkpoint : null,
          nudgeDelivered: false,
        });
        if (pendingNudge) {
          debugEvent(sessionPath, "threshold_nudge_pending", {
            usedPercentage: thresholdUsedPercentage,
            checkpointPercentage: checkpoint,
          });
          log("info", `[nudge] Pi threshold is ${thresholdUsedPercentage.toFixed(1)}% used; pending checkpoint=${checkpoint}% advisory will be delivered before yielding`);
        }
      }
      debugEvent(sessionPath, "threshold_compaction_intercepted_once", {
        contextTokens: current.state.metrics.piContextUsageTokens,
        pendingNudge: thresholdInterceptions.get(key)?.pendingNudge === true,
        nudgeCheckpoint: thresholdInterceptions.get(key)?.nudgeCheckpoint ?? null,
      });
      log("info", "[compaction] intercepted first Pi threshold request; yielding the next one if Big Pi makes no compression progress");
    }

    // Do not veto every threshold check while an ignored pressure advisory lets
    // the same task grow toward overflow. Pi performs native compaction serially.
    if (event.reason === "threshold" && runtime.active && runtime.attempts > 0 &&
        !compressionPhases.has(phaseKey(current)) && !runtime.compressionFollowUpQueued &&
        (runtime.attempts >= config.emergency.maxAttemptsPerTurn ||
         (current.state.metrics.piContextUsageTokens !== null &&
          runtime.lastAttemptEffectiveTokens !== null &&
          current.state.metrics.piContextUsageTokens >= runtime.lastAttemptEffectiveTokens))) {
      runtime.nativeFallbackState = "pending";
      diagnostics.lastResult = "yielded to Pi (no compression progress)";
      try {
        persistEmergency(current, {
          lastOutcome: "fallback-pending", nativeFallbackState: "pending",
          activeEpisode: "pressure", lastReason: "Pressure guidance made no compression progress before native threshold",
        });
      } catch (error) {
        log("warning", `[emergency] could not persist threshold fallback diagnostics: ${error.message}`);
      }
      log("warning", "[compaction] pressure guidance made no progress; yielding threshold compaction to Pi");
      return;
    }

    diagnostics.cancelled++;
    diagnostics.lastResult = "cancelled";
    log("info", `[compaction] cancelled; owner=big-pi reason=${event.reason}`);
    return { cancel: true };
  });

  pi.on("session_compact", (event, ctx) => {
    if (event.fromExtension) return;
    try {
      const key = usageMeterKey(ctx);
      providerUsageAnchors.delete(key);
      lastSentEstimates.delete(key);
      awaitingPostCompactionUsage.add(key);
      const current = refresh(ctx);
      endCompressionPhase(current, "native compaction completed");
      thresholdInterceptions.delete(phaseKey(current));
      if (!["overflow", "threshold"].includes(event.reason)) return;
      const runtime = emergencyRuntime(current);
      if (runtime.nativeFallbackState !== "pending") return;
      runtime.nativeFallbackState = "completed";
      runtime.active = false;
      runtime.overflowActive = false;
      runtime.activeEpisode = "none";
      runtime.interrupted = false;
      runtime.attempts = 0;
      runtime.lastAttemptEffectiveTokens = null;
      awaitingEmergencyUsageAfterFallback.add(key);
      diagnosticsFor(current.sessionPath).lastResult = "Pi fallback completed; ownership resumed";
      persistEmergency(current, {
        lastOutcome: "fallback-completed",
        nativeFallbackState: "completed",
        activeEpisode: "none",
        lastReason: `Pi native ${event.reason} compaction completed; big-pi ownership resumed`,
      });
      log("info", "[emergency] Pi native fallback completed; big-pi ownership resumed before Pi retry");
      debugEvent(current.sessionPath, "native_fallback_completed", {
        staleEmergencyFollowUpSuppressed: true,
      });
    } catch (error) {
      log("warning", `[emergency] could not observe Pi fallback completion; keeping current ownership diagnostics reason=${error.message}`);
    }
  });

  pi.on("session_compact_failed", (event, ctx) => {
    if (["overflow", "threshold"].includes(event.reason) && !event.fromExtension) {
      if (event.reason === "threshold") {
        try { if (emergencyRuntime(refresh(ctx)).nativeFallbackState !== "pending") return; }
        catch { return; }
      }
      let sessionPath;
      try { sessionPath = getSessionPath(ctx); } catch { sessionPath = undefined; }
      debugEvent(sessionPath, "native_fallback_failed", { willRetry: event.willRetry === true });
      log(
        "warning",
        `[emergency] Pi reported ${event.reason} compaction aborted willRetry=${event.willRetry}; interrupted request is not automatically replayed by big-pi`,
      );
      try {
        const current = refresh(ctx);
        const runtime = emergencyRuntime(current);
        if (runtime?.nativeFallbackState === "pending") {
          runtime.nativeFallbackState = "failed";
          persistEmergency(current, {
            lastOutcome: "fallback-failed",
            nativeFallbackState: "failed",
            activeEpisode: "overflow",
            lastReason: `Pi native ${event.reason} compaction failed or was aborted; Pi scheduled no retry`,
          });
        }
      } catch (error) {
        log("warning", `[emergency] could not persist Pi compaction failure diagnostics reason=${error.message}`);
      }
    }
  });

  function prepareCompressionGuidance(event, ctx, persistRefresh = true) {
    try {
      const current = refresh(ctx, persistRefresh);
      const { metrics } = current.state;
      const queuedRuntime = emergencyRuntime(current);
      if (queuedRuntime.compressionFollowUpQueued) {
        queuedRuntime.compressionFollowUpStarted = true;
        debugEvent(current.sessionPath, "emergency_follow_up_started", { attempt: queuedRuntime.attempts });
        log("info", "[compression] queued follow-up turn started; session queue lock remains held until it settles");
      }
      if (awaitingEmergencyUsageAfterFallback.has(usageMeterKey(ctx))) {
        debugEvent(current.sessionPath, "stale_emergency_follow_up_suppressed");
        return {
          systemPrompt: `${event.systemPrompt}\n\nBig Pi recovery update: Pi native compaction has already completed the pending emergency recovery. The old Big Pi compression request is superseded. Continue the user's original task from the compacted context; do not call Big Pi compression tools based on the earlier pressure. Big Pi will reassess after a fresh provider usage report.`,
        };
      }
      const recovery = settleEmergency(current, ctx);
      const emergencyState = currentEmergencyState(current, recovery);
      if (piOwnsCompaction(recovery)) {
        log("debug", "[emergency] Pi owns fallback; suppressing additional compression guidance");
        return;
      }
      if (config.emergency.enabled && emergencyState !== "NORMAL") {
        if (
          recovery.attempts >= config.emergency.maxAttemptsPerTurn ||
            (recovery.attempts > 0 && !recovery.retryAfterNoToolCall &&
            (metrics.piContextUsageTokens === null ||
              metrics.piContextUsageTokens >= recovery.lastAttemptEffectiveTokens))
        ) {
          recovery.active = true;
          log("debug", recovery.attempts >= config.emergency.maxAttemptsPerTurn
            ? `[emergency] attempts exhausted (${config.emergency.maxAttemptsPerTurn}); awaiting native fallback`
            : "[emergency] pressure request already delivered at this effective-context level; suppressing repeat");
          return;
        }
        const sources = compressionSources(current);
        const tier1Promotions = !sources.length && config.hierarchy.enabled ? blockCompressionSources(current, 1) : [];
        const tier2Promotions = !sources.length && !tier1Promotions.length && config.hierarchy.enabled
          ? blockCompressionSources(current, 2)
          : [];
        const at = new Date().toISOString();
        const pressure = emergencyPressure(current);
        if (!sources.length && !tier1Promotions.length && !tier2Promotions.length) {
          recovery.active = true;
          recovery.attempts = config.emergency.maxAttemptsPerTurn;
          recovery.activeEpisode = "pressure";
          recovery.nativeFallbackState = "pending";
          const reason = metrics.activeBlockCount > 0
            ? "no safe uncovered range or qualified hierarchy promotion exists"
            : "no safe eligible range exists; protected/recent context and minimum range rules preserved";
          try {
            persistEmergency(current, {
              lastPressureAt: at,
              lastOutcome: "fallback-pending",
              activeEpisode: "pressure",
              nativeFallbackState: "pending",
              lastEstimatedReclaimTokens: pressure.estimatedReclaimTokens,
              lastReason: reason,
            });
          } catch (error) {
            log("error", `[emergency] could not persist no-range diagnostics: ${error.message}`);
          }
          log("warning", "[emergency] no safe eligible range exists");
          debugEvent(current.sessionPath, "emergency_yielded_to_pi", {
            reason: "recovery_unavailable",
            attempt: recovery.attempts,
          });
          return;
        }
        const attempt = recovery.attempts + 1;
        recovery.attempts = attempt;
        recovery.active = true;
        recovery.activeEpisode = "pressure";
        recovery.lastAttemptEffectiveTokens = metrics.piContextUsageTokens;
        recovery.retryAfterNoToolCall = false;
        try {
          persistEmergency(current, {
            lastPressureAt: at,
            lastOutcome: "requested",
            activeEpisode: "pressure",
            nativeFallbackState: "none",
            lastEstimatedReclaimTokens: pressure.estimatedReclaimTokens,
            lastReason: null,
          });
        } catch (error) {
          recovery.attempts--;
          recovery.active = false;
          log("error", `[emergency] unable to persist pressure request; skipped guidance reason=${error.message}`);
          return;
        }
        log(
          "warning",
          `[emergency] pressure entered used=${pressure.usedPercentage?.toFixed(1) ?? "unknown"} ` +
          `target=${config.emergency.targetPercentageAfterCompression} reclaim=${pressure.estimatedReclaimTokens ?? "unknown"}`,
        );
        log("info", "[emergency] high-priority compression requested");
        debugEvent(current.sessionPath, "pressure_compression_requested", {
          attempt,
          sourceType: sources.length ? "raw" : "blocks",
          candidateCount: sources.length || tier1Promotions.length || tier2Promotions.length,
        });
        return {
          systemPrompt: `${event.systemPrompt}\n\n${emergencyGuidance(current, attempt)}`,
        };
      }
      const key = phaseKey(current);
      const interceptedThreshold = thresholdInterceptions.get(key);
      const thresholdAdvisory = config.nudge.mode !== "growth" &&
        interceptedThreshold?.pendingNudge === true &&
        metrics.percentageStatus === "available" &&
        metrics.percentageNextCheckpoint === interceptedThreshold.nudgeCheckpoint;
      const growthDue = config.nudge.mode !== "percentage" && metrics.growthNudgeDue;
      const percentageDue = config.nudge.mode !== "growth" &&
        (metrics.percentageNudgeDue || thresholdAdvisory);
      const hierarchyCadence = current.state.compression.hierarchy.projections[current.growthProjection.id];
      const oldTier2Latch = hierarchyCadence.tier2NudgeLatched;
      const oldTier3Latch = hierarchyCadence.tier3NudgeLatched;
      const tier2NudgeDue = metrics.tier2PromotionDue && !oldTier2Latch;
      const tier3NudgeDue = metrics.tier3PromotionDue && !oldTier3Latch;
      hierarchyCadence.tier2NudgeLatched = metrics.tier2PromotionDue;
      hierarchyCadence.tier3NudgeLatched = metrics.tier3PromotionDue;
      if (tier2NudgeDue || tier3NudgeDue) hierarchyCadence.lastNudgeAt = new Date().toISOString();
      const hierarchyLatchChanged =
        oldTier2Latch !== hierarchyCadence.tier2NudgeLatched ||
        oldTier3Latch !== hierarchyCadence.tier3NudgeLatched;
      const growthCadence = current.state.compression.growth.projections[current.growthProjection.id];
      if (!growthDue && !percentageDue && !tier2NudgeDue && !tier3NudgeDue) {
        if (hierarchyLatchChanged) persistState(current.sidecar, current.state);
        if (config.nudge.mode === "hybrid") {
          log("debug", "[nudge] hybrid due growth=false percentage=false");
        } else if (config.nudge.mode !== "growth" && metrics.percentageStatus === "available") {
          log(
            "debug",
            `[nudge] mode=${config.nudge.mode} used=${metrics.currentUsedPercentage.toFixed(1)} ` +
            `threshold=${config.nudge.thresholdPercentage} due=false`,
          );
        } else {
          log(
            "debug",
            `[nudge] growth=${metrics.growthSinceBaselineTokens} threshold=${config.nudge.growthTriggerTokens} due=false${
              growthCadence?.lastNudgeAt ? "; interval already delivered; suppressing duplicate" : ""
            }`,
          );
        }
        return;
      }
      const at = new Date().toISOString();
      let deliveredPercentageCheckpoint = null;
      if (growthDue) {
        recordGrowthNudge(
          current.state,
          current.growthProjection.id,
          metrics.growthSinceBaselineTokens,
          at,
        );
        metrics.lastNudgeAt = at;
        metrics.lastNudgeGrowthTokens = metrics.growthSinceBaselineTokens;
        metrics.nextNudgeAtGrowthTokens = metrics.growthSinceBaselineTokens + config.nudge.growthTriggerTokens;
      }
      if (percentageDue) {
        const checkpoint = thresholdAdvisory
          ? interceptedThreshold.nudgeCheckpoint
          : metrics.percentageNextCheckpoint;
        deliveredPercentageCheckpoint = checkpoint;
        recordPercentageNudge(
          current.state,
          current.growthProjection.id,
          checkpoint,
          at,
        );
        metrics.percentageLastDeliveredCheckpoint = checkpoint;
        metrics.percentageNextCheckpoint = checkpoint + config.nudge.repeatEveryPercentage;
        if (thresholdAdvisory) {
          interceptedThreshold.pendingNudge = false;
          interceptedThreshold.nudgeDelivered = true;
          thresholdInterceptions.set(key, interceptedThreshold);
          debugEvent(current.sessionPath, "threshold_nudge_delivered_before_checkpoint", {
            usedPercentage: metrics.currentUsedPercentage,
            checkpointPercentage: checkpoint,
          });
          log("info", `[nudge] delivered pending ${checkpoint}% checkpoint at Pi native threshold (${metrics.currentUsedPercentage.toFixed(1)}% used)`);
        }
        log("info", `[nudge] crossed percentage checkpoint=${checkpoint}`);
        log("info", "[nudge] delivered percentage advisory");
        log("info", `[nudge] next percentage checkpoint=${metrics.percentageNextCheckpoint}`);
      }
      metrics.nextNudgeAtGrowthTokens = growthDue
        ? metrics.nextNudgeAtGrowthTokens
        : current.state.compression.growth.projections[current.growthProjection.id].cadenceNudgeGrowthTokens === null
          ? config.nudge.growthTriggerTokens
          : current.state.compression.growth.projections[current.growthProjection.id].cadenceNudgeGrowthTokens +
            config.nudge.growthTriggerTokens;
      metrics.nudgeDue = false;
      if (growthDue) metrics.growthNudgeDue = false;
      if (percentageDue) metrics.percentageNudgeDue = false;
      persistState(current.sidecar, current.state);
      if (config.nudge.mode === "hybrid") {
        log("info", `[nudge] hybrid due growth=${growthDue} percentage=${percentageDue}`);
      }
      if (growthDue) {
        log(
          "info",
          `[nudge] growth=${metrics.growthSinceBaselineTokens} threshold=${config.nudge.growthTriggerTokens} due=true; advisory delivered`,
        );
      }
      if (metrics.currentUsedPercentage !== null) {
        log(
          "info",
          `[nudge] used=${metrics.currentUsedPercentage.toFixed(1)} remaining=${metrics.currentRemainingPercentage.toFixed(1)} ` +
          `checkpoint=${percentageDue ? metrics.percentageLastDeliveredCheckpoint : metrics.percentageLastDeliveredCheckpoint ?? "none"}`,
        );
      }
      const hierarchyGuidance = [
        tier2NudgeDue
          ? `Tier-1 active applicable summary mass is ~${formatTokens(metrics.hierarchy[0].summaryTokensEstimate)} estimated tokens (threshold ${formatTokens(config.hierarchy.tier2NudgeSummaryTokens)}). Consider consolidating a semantically coherent contiguous run of at least ${Math.max(2, config.hierarchy.minBlocksPerPromotion)} Tier-1 blocks into Tier 2 if it reduces context.`
          : "",
        tier3NudgeDue
          ? `Tier-2 active applicable summary mass is ~${formatTokens(metrics.hierarchy[1].summaryTokensEstimate)} estimated tokens (threshold ${formatTokens(config.hierarchy.tier3NudgeSummaryTokens)}). Consider distilling a semantically coherent contiguous run of Tier-2 blocks into Tier 3 if it reduces context.`
          : "",
      ].filter(Boolean).join(" ");
      if (tier2NudgeDue || tier3NudgeDue) {
        log("info", `[hierarchy] tier1 summary mass=${metrics.hierarchy[0].summaryTokensEstimate} tier2Due=${metrics.tier2PromotionDue} tier2 mass=${metrics.hierarchy[1].summaryTokensEstimate} tier3Due=${metrics.tier3PromotionDue}`);
      }
      const normalGuidance = growthDue || percentageDue
        ? buildNudge(metrics, growthDue, percentageDue, deliveredPercentageCheckpoint, thresholdAdvisory)
        : "";
      return {
        systemPrompt: `${event.systemPrompt}\n\n${[normalGuidance, hierarchyGuidance].filter(Boolean).join("\n\n")}`,
      };
    } catch (error) {
      if (error instanceof StateIntegrityError) rememberIntegrityFailure(ctx, error);
      warnUser(ctx, `Unable to evaluate growth nudge; active-agent guidance remains unchanged: ${error.message}`);
      return;
    }
  }

  pi.on("before_agent_start", (event, ctx) => {
    const result = prepareCompressionGuidance(event, ctx);
    if (result?.systemPrompt && /big-pi emergency/i.test(result.systemPrompt)) {
      const current = refresh(ctx, false);
      pendingCompressionGuidance.set(phaseKey(current), result.systemPrompt.slice(event.systemPrompt.length));
    }
    return result;
  });

  pi.on("tool_call", (event, ctx) => {
    try {
      const current = refresh(ctx, false);
      const phase = compressionPhases.get(phaseKey(current));
      if (compressionTools.has(event.toolName) &&
          awaitingEmergencyUsageAfterFallback.has(usageMeterKey(ctx))) {
        return {
          block: true,
          reason: "Pi native compaction already completed this emergency recovery. Do not resume the queued Big Pi compression request; continue the original task until fresh provider usage is available.",
        };
      }
      if (phase?.budgetExhausted && compressionTools.has(event.toolName)) {
        return { block: true, reason: "Big Pi has yielded this recovery attempt to Pi native compaction. Continue the original task; do not retry Big Pi compression tools." };
      }
      if (!phase && compressionTools.has(event.toolName) && piOwnsCompaction(emergencyRuntime(current))) {
        return { block: true, reason: "Big Pi has yielded recovery to Pi native compaction. Continue the original task; do not retry Big Pi compression tools." };
      }
      if (compressionTools.has(event.toolName) || !phase) return;
      return {
        block: true,
        reason: "Big Pi compression phase: task tools are paused. Call big_pi_compression_sources, then big_pi_compress with your own summary before resuming the task.",
      };
    } catch (error) {
      warnUser(ctx, `Compression tool gate failed open: ${error.message}`, "compression-gate");
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    try {
      const current = refresh(ctx);
      const runtime = emergencyRuntime(current);
      const phase = compressionPhases.get(phaseKey(current));
      if (phase && runtime.active && runtime.nativeFallbackState === "none") {
        if (phase.compressionAttempts === 0 && phase.failedAttempts === 0 &&
            runtime.activeEpisode === "pressure" && config.emergency.enabled &&
            runtime.attempts < config.emergency.maxAttemptsPerTurn &&
            !runtime.compressionFollowUpQueued) {
          runtime.retryAfterNoToolCall = true;
          try {
            persistEmergency(current, {
              lastOutcome: "requested",
              nativeFallbackState: "none",
              activeEpisode: "pressure",
              lastReason: "Emergency response ended without a compression tool call; one bounded retry is queued",
            });
            queueEmergencyCompression(current, runtime.attempts + 1);
            debugEvent(current.sessionPath, "emergency_retry_queued_after_no_tool_call", {
              attempt: runtime.attempts + 1,
              maxAttempts: config.emergency.maxAttemptsPerTurn,
            });
            log("warning", `[compression] no compression tool call was made; queued one bounded retry (${runtime.attempts + 1}/${config.emergency.maxAttemptsPerTurn})`);
            endCompressionPhase(current, "bounded retry queued after no tool call");
            return;
          } catch (error) {
            runtime.retryAfterNoToolCall = false;
            log("warning", `[compression] could not queue bounded retry; yielding to Pi reason=${error.message}`);
          }
        }
        yieldCompressionPhaseToPi(current, phase,
          `compression turn ended without committing a block after ${phase.requests} context request(s); yielding to Pi native compaction`);
      }
      endCompressionPhase(current, phase?.budgetExhausted
        ? "phase budget settled without a committed block"
        : "turn ended without a committed block");
      if (runtime.compressionFollowUpQueued && runtime.compressionFollowUpStarted) {
        runtime.compressionFollowUpQueued = false;
        runtime.compressionFollowUpStarted = false;
        log("info", "[compression] queued follow-up turn settled; session queue lock released");
      }
    } catch (error) {
      log("warning", `[compression] could not release settled-turn queue lock reason=${error.message}`);
    }
  });

  pi.on("context", (event, ctx) => {
    try {
      const current = refresh(ctx, false);
      const transformed = transformContext(
        event.messages,
        current.bindings,
        current.state.blocks,
        current.protectedRegion.refs,
      );
      const meterKey = usageMeterKey(ctx);
      const sentEstimate = estimateTokens(transformed);
      const usageAnchor = providerUsageAnchors.get(meterKey);
      const matchingUsageAnchor = usageAnchor?.growthProjectionId === current.growthProjection.id ? usageAnchor : null;
      const calibratedUsage = matchingUsageAnchor
        ? calibrateContextEstimate(sentEstimate, matchingUsageAnchor.contextTokensAfterTurn, matchingUsageAnchor.estimateAtRequest)
        : null;
      updateMetrics(
        current.state,
        current.bindings,
        current.protectedRegion.refs,
        current.projection.messages,
        transformed,
        ctx.getContextUsage?.(),
        current.growthProjection,
        config.nudge,
        current.state.metrics.usableContextWindow,
        current.state.metrics.percentageUnavailableReason,
        calibratedUsage,
        matchingUsageAnchor?.contextTokensAfterTurn ?? null,
      );
      lastSentEstimates.set(meterKey, sentEstimate);
      current.emergencyPressure = calculateEmergencyPressure(
        current.state.metrics.piContextUsageTokens,
        current.state.metrics.usableContextWindow,
        config.emergency,
      );
      const measuredContextTokens = current.state.metrics.piContextUsageTokens;
      const measuredContextWindow = current.state.metrics.usableContextWindow;
      const measuredUsedPercent = measuredContextTokens !== null && measuredContextWindow
        ? measuredContextTokens / measuredContextWindow * 100
        : null;
      debugEvent(current.sessionPath, "context_usage_checkpoint", {
        source: matchingUsageAnchor ? "provider-after-turn" : "provider-unavailable",
        measuredTokens: measuredContextTokens,
        contextWindow: measuredContextWindow,
        usedPercentage: measuredUsedPercent,
        nudgeDue: current.state.metrics.percentageNudgeDue,
        emergencyDue: current.emergencyPressure.pressure,
      });
      log("debug", `[usage] context checkpoint source=${matchingUsageAnchor ? "provider-after-turn" : "unavailable"} tokens=${measuredContextTokens ?? "unknown"} window=${measuredContextWindow ?? "unknown"} used=${measuredUsedPercent?.toFixed(1) ?? "unknown"}% emergency=${current.emergencyPressure.pressure}`);
      notifiedFailures.delete("context-projection");
      log("debug", `context hook projected=${current.projection.messages.length} event=${event.messages.length} effective=${estimateTokens(transformed)}`);
      const key = phaseKey(current);
      let phase = compressionPhases.get(key);
      let guidance;
      let emergencyGuidanceRequested = false;
      if (phase && piOwnsCompaction(emergencyRuntime(current))) {
        endCompressionPhase(current, "native fallback");
        phase = undefined;
      }
      if (!phase) {
        const pending = pendingCompressionGuidance.get(key);
        pendingCompressionGuidance.delete(key);
        guidance = pending ?? prepareCompressionGuidance({ systemPrompt: "" }, ctx, false)?.systemPrompt;
        emergencyGuidanceRequested = guidance && /big-pi emergency/i.test(guidance);
        if (emergencyGuidanceRequested && (compressionSources(current).length ||
            blockCompressionSources(current, 1).length || blockCompressionSources(current, 2).length)) {
          phase = { guidance, requests: 0, compressionAttempts: 0, failedAttempts: 0, budgetExhausted: false };
          compressionPhases.set(key, phase);
          debugEvent(current.sessionPath, "compression_phase_started", {});
          log("info", "[compression] model-driven phase started; task tools paused");
        }
      }
      if (phase && phase.lastDiscovery?.sourceType === "blocks" && phase.lastDiscovery.tier === 2 &&
          phase.lastDiscovery.candidates.length === 0) {
        debugEvent(current.sessionPath, "compression_phase_no_eligible_candidates", { sourceType: "blocks", tier: 2 });
        yieldCompressionPhaseToPi(current, phase,
          "no eligible raw or hierarchy candidate exists; yielding to Pi native compaction");
        return { messages: [...transformed, {
          role: "user",
          content: [{ type: "text", text: "Big Pi found no eligible range or hierarchy candidate. Recovery has been handed to Pi native compaction. Continue the original task after compaction." }],
          timestamp: Date.now(),
        }] };
      }
      if (phase?.budgetExhausted) return { messages: transformed };
      if (phase && phase.requests >= MAX_COMPRESSION_REQUESTS) {
        phase.budgetExhausted = true;
        debugEvent(current.sessionPath, "compression_phase_budget_exhausted", {
          requests: phase.requests,
          compressionAttempts: phase.compressionAttempts,
          failedAttempts: phase.failedAttempts,
        });
        yieldCompressionPhaseToPi(current, phase,
          `compression prompt budget exhausted after ${phase.requests} context requests; yielding to Pi native compaction`);
        log("warning", "[compression] ordinary task tools are available again; Big Pi compression calls are paused during native fallback");
        return { messages: [...transformed, {
          role: "user",
          content: [{ type: "text", text: "Big Pi's compression prompt budget is exhausted and recovery has been handed to Pi native compaction. Do not retry Big Pi compression tools. Continue the original task after Pi compaction." }],
          timestamp: Date.now(),
        }] };
      }
      if (phase) {
        phase.requests++;
        return { messages: [...transformed, {
          role: "user",
          content: [{ type: "text", text:
            `${phase.guidance}\n\nBIG-PI EMERGENCY COMPRESSION (request ${phase.requests}/${MAX_COMPRESSION_REQUESTS}). Your next response must be a tool call, not prose or application-task work. ${compressionPhaseStep(phase)} Preserve durable decisions, facts, verification results, failures, and open work. Never guess IDs or weaken protections. Normal task tools are paused. After a block is committed, resume the user's task automatically.`,
          }],
          timestamp: Date.now(),
        }] };
      }
      if (guidance && !emergencyGuidanceRequested) {
        return { messages: [...transformed, {
          role: "user",
          content: [{ type: "text", text: `${guidance.trim()} The model may choose whether to compress; continue the active task if compression is not useful.` }],
          timestamp: Date.now(),
        }] };
      }
      return { messages: transformed };
    } catch (error) {
      if (error instanceof StateIntegrityError) rememberIntegrityFailure(ctx, error);
      if (error instanceof ProjectionError) {
        log("warning", "[compaction] transient context failure does not relinquish ownership");
      }
      try { endCompressionPhase(refresh(ctx, false), "context failed open"); } catch {
        compressionPhases.clear();
        pendingCompressionGuidance.clear();
      }
      warnUser(
        ctx,
        `Context transformation failed open; this request remains unchanged and later requests will retry: ${error.message}`,
        "context-projection",
      );
      return { messages: event.messages };
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId?.() ?? "<session>";
    const prefix = `${sessionId}\0`;
    for (const map of [lastSentEstimates, providerUsageAnchors, learnedContextWindows]) {
      for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
    }
  });
}
