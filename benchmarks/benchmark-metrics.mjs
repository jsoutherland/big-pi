export function workTurnContext(message, completedAt = null) {
  if (message?.role !== "assistant" || !message.usage || typeof message.usage !== "object") return null;
  const toolNames = (Array.isArray(message.content) ? message.content : [])
    .filter((item) => item?.type === "toolCall" && typeof item.name === "string")
    .map((item) => item.name);
  const category = classifyUsageTurn(toolNames);
  const usage = message.usage;
  const promptContextTokens = [usage.input, usage.cacheRead, usage.cacheWrite]
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);
  const outputTokens = Number.isFinite(usage.output) ? usage.output : 0;
  return {
    category,
    promptContextTokens,
    outputTokens,
    estimatedContextAfterCompletion: promptContextTokens + outputTokens,
    completedAt,
  };
}

export function classifyUsageTurn(toolNames = []) {
  const bigPiTools = toolNames.filter((name) => name.startsWith("big_pi_"));
  const billionContextPiCompress = toolNames.includes("compress");
  if (bigPiTools.includes("big_pi_compress")) {
    return bigPiTools.some((name) => name !== "big_pi_compress") ? "compressionAndOtherBigPi" : "compressionAttempt";
  }
  if (billionContextPiCompress) return "compressionAttempt";
  return bigPiTools.length ? "otherBigPiTool" : "work";
}

export function summarizeUsageTurns(turns) {
  const categories = ["work", "compressionAttempt", "otherBigPiTool", "compressionAndOtherBigPi"];
  const result = Object.fromEntries(categories.map((category) => {
    const selected = turns.filter((turn) => turn.category === category);
    return [category, {
      turns: selected.length,
      promptContextTokens: selected.reduce((sum, turn) => sum + turn.promptContextTokens, 0),
      outputTokens: selected.reduce((sum, turn) => sum + turn.outputTokens, 0),
      peakPromptContextTokens: selected.length ? Math.max(...selected.map((turn) => turn.promptContextTokens)) : null,
      latestPromptContextTokens: selected.at(-1)?.promptContextTokens ?? null,
    }];
  }));
  return result;
}

export function summarizeWorkContext(turns) {
  const workTurns = turns.filter((turn) => turn.category === "work");
  const peakPrompt = Math.max(0, ...workTurns.map((turn) => turn.promptContextTokens));
  const peakAfterCompletion = Math.max(0, ...workTurns.map((turn) => turn.estimatedContextAfterCompletion));
  const latest = workTurns.at(-1) ?? null;
  return {
    source: "provider-reported usage from ordinary Pi assistant turns",
    bigPiToolTurnsIncluded: false,
    workTurnsWithUsage: workTurns.length,
    peakWorkPromptContextTokens: workTurns.length ? peakPrompt : null,
    peakEstimatedContextAfterWorkCompletion: workTurns.length ? peakAfterCompletion : null,
    latestWorkPromptContextTokens: latest?.promptContextTokens ?? null,
    estimatedContextAfterLatestWorkCompletion: latest?.estimatedContextAfterCompletion ?? null,
    usageByTurnCategory: summarizeUsageTurns(turns),
    latestWorkCompletionAt: latest?.completedAt ?? null,
  };
}

export function flattenWorkContextMetrics(workContext) {
  return {
    peakWorkPromptContextTokens: workContext?.peakWorkPromptContextTokens ?? null,
    peakEstimatedContextAfterWorkCompletion: workContext?.peakEstimatedContextAfterWorkCompletion ?? null,
    latestWorkPromptContextTokens: workContext?.latestWorkPromptContextTokens ?? null,
    estimatedContextAfterLatestWorkCompletion: workContext?.estimatedContextAfterLatestWorkCompletion ?? null,
  };
}
