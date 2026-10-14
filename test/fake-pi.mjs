import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
const bigPiLoaded = args.includes("--extension");
const billionContextPiLoaded = bigPiLoaded && !process.env.BIG_PI_CONFIG;
const modelId = args[args.indexOf("--model") + 1] ?? "fake-model";
await mkdir(sessionDir, { recursive: true });
const sessionFile = path.join(sessionDir, "fake-session.jsonl");
await writeFile(sessionFile, "{}\n");
await writeFile(path.join(sessionDir, "fake-launch-info.json"), JSON.stringify({
  args,
  bigPiEnvironment: Object.keys(process.env).filter((name) => name.startsWith("BIG_PI_")),
}));
if (bigPiLoaded) {
  if (billionContextPiLoaded) {
    await writeFile(`${sessionFile}.acp.json`, JSON.stringify({
      producer: "billion-context-pi@1.2.3",
      schemaVersion: 1,
      blocks: [{ blockId: "b1", tier: 1 }, { blockId: "b2", tier: 2 }, { blockId: "b3", tier: 3 }],
    }));
  } else {
  await mkdir(`${sessionFile}.big-pi`, { recursive: true });
  if (process.env.BIG_PI_LOG_PATH) await writeFile(process.env.BIG_PI_LOG_PATH, "fake Big Pi development log\n");
  if (process.env.BIG_PI_DUMP_DIR) {
    await mkdir(process.env.BIG_PI_DUMP_DIR, { recursive: true });
    await writeFile(path.join(process.env.BIG_PI_DUMP_DIR, "fake-context-dump.txt"), "fake diagnostic context dump\n");
  }
  await writeFile(path.join(`${sessionFile}.big-pi`, "manifest.json"), JSON.stringify({
    blocks: [{ tier: 1, status: "active" }, { tier: 2, status: "superseded" }, { tier: 3, status: "active" }],
    compression: { totalBlockCount: 3 },
  }));
  await writeFile(`${sessionFile}.big-pi-debug.jsonl`, [
    JSON.stringify({ at: new Date().toISOString(), event: "session_start", version: "fake" }),
    "",
  ].join("\n") + "\n");
  }
}

let recoveryBusy = false;
const readinessTest = args.includes("--test-recovery-readiness");
const compactionFailureTest = args.includes("--test-compaction-failure");
const postCompactionContextTest = args.includes("--test-post-compaction-context");
const distinctPromptUsageTest = args.includes("--test-distinct-prompt-usage");
const send = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
process.stderr.write(`fake Pi online; stdin isTTY=${process.stdin.isTTY}\n`);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let compressionCallNo = 0;
let promptNumber = 0;
input.on("line", async (line) => {
  process.stderr.write(`received command ${line.slice(0, 100)}\n`);
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionFile, model: { provider: "fake", id: modelId, contextWindow: 1000 }, autoCompactionEnabled: true, isStreaming: recoveryBusy, isCompacting: recoveryBusy, pendingMessageCount: recoveryBusy ? 1 : 0 } });
  } else if (command.type === "get_session_stats") {
    send({ type: "response", id: command.id, command: command.type, success: true, data: { contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 } } });
  } else if (command.type === "prompt") {
    const currentPromptNumber = ++promptNumber;
    if (recoveryBusy) throw new Error("Prompt submitted during recovery");
    if (readinessTest) {
      recoveryBusy = true;
      for (let i = 0; i < 3; i++) {
        send({ type: "compaction_start", reason: "threshold" });
        send({ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false });
      }
      send({ type: "queue_update", followUp: ["compress history"], steering: [] });
      send({ type: "agent_settled" });
      setTimeout(() => {
        send({ type: "agent_start" });
        recoveryBusy = false;
        send({ type: "queue_update", followUp: [], steering: [] });
        send({ type: "agent_settled" });
      }, 150);
    }
    send({ type: "response", id: command.id, command: command.type, success: true, data: { disposition: "started" } });
    send({ type: "message_start", message: { role: "assistant" } });
    const promptTokens = distinctPromptUsageTest ? 80 + currentPromptNumber : 100;
    send({ type: "turn_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }], usage: { input: promptTokens, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: promptTokens + 10 } } });
    send({ type: "message_start", message: { role: "assistant" } });
    if (bigPiLoaded && !billionContextPiLoaded) {
      send({ type: "turn_end", message: { role: "assistant", content: [{ type: "toolCall", name: "big_pi_compression_sources" }], usage: { input: 25, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 28 } } });
      send({ type: "turn_end", message: { role: "assistant", content: [{ type: "toolCall", name: "big_pi_compress" }], usage: { input: 50, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 54 } } });
    }
    send({ type: "compaction_start", reason: "overflow" });
    if (bigPiLoaded && !billionContextPiLoaded) {
      const toolCallId = `compression-${++compressionCallNo}`;
      if (compressionCallNo === 1) {
        await appendFile(`${sessionFile}.big-pi-debug.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), event: "compression_applied", toolCallId, tier: 1 })}\n`);
      }
      send({ type: "tool_execution_start", toolCallId: `sources-${compressionCallNo}`, toolName: "big_pi_compression_sources" });
      send({ type: "tool_execution_end", toolCallId: `sources-${compressionCallNo}`, toolName: "big_pi_compression_sources" });
      send({ type: "tool_execution_start", toolCallId, toolName: "big_pi_compress" });
      send({ type: "tool_execution_end", toolCallId, toolName: "big_pi_compress" });
    }
    send({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: readinessTest, ...(compactionFailureTest ? { errorMessage: "Context overflow recovery failed after one compact-and-retry attempt" } : {}) });
    if (postCompactionContextTest) {
      send({ type: "message_start", message: { role: "assistant" } });
      send({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "Continuing after compaction." }], usage: { input: 62, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 66 } } });
    }
    send({ type: "agent_settled" });
  }
});
