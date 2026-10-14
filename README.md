# big-pi

**Installing big-pi? Start with [START_HERE.md](START_HERE.md).**

big-pi is a standalone Pi extension that lets the active model compress completed conversation phases while preserving Pi's original JSONL transcript. It addresses context growth without silently deleting or rewriting the conversation.

The approach was inspired by [billion-context-pi](https://github.com/ranxianglei/billion-context-pi). The active model chooses semantic ranges and writes summaries. Tier 1 compresses eligible raw messages; Tier 2 consolidates Tier-1 blocks; Tier 3 consolidates Tier-2 blocks. Only one highest applicable representation of a source range is sent to the model. No hidden summarizer or automatic range selector is used.

Growth, percentage, and hybrid checkpoints are checked before every model request, including between tool cycles within a long prompt. When eligible sources exist, big-pi enters a bounded compression phase: task tools pause while the active model discovers candidates and writes a summary. A committed block releases the gate. If the six-request prompt budget is reached, Big Pi keeps task tools gated, stops further compression calls, and lets the active agent response settle before yielding to native compaction. Big Pi also intercepts Pi-native compaction while its state is healthy and offers bounded, model-driven emergency recovery for context pressure or overflow; unsafe or failed recovery yields to Pi's native fallback.

Pi-native compaction does not create Big Pi chunks. The chunk count includes only successful `big_pi_compress` operations; native compaction is Pi's separate transcript compaction.

## Active-agent compression

`/big-pi compact` queues a follow-up instruction for the active model. Before using `big_pi_compress`, the model must call `big_pi_compression_sources` and select one returned contiguous eligible candidate. Pass its `candidateId` with an agent-written summary; the ID binds the call to that exact eligible range and avoids copying start/end refs or block IDs. Each candidate reports a minimum and recommended summary length. Legacy ref and block-ID forms remain accepted.

Raw Tier-1 example:

```json
{"candidateId":"C-0123456789abcdef","summary":"Preserve the decisions, constraints, tests, and unresolved work."}
```

Hierarchy promotion example:

```json
{"candidateId":"C-fedcba9876543210","summary":"Consolidate these completed phases and their open issues."}
```

Use exactly one source form. Never guess candidate IDs or include protected messages; if validation fails, refresh candidates and correct the request instead of repeating it unchanged.

Tool calls and their matching results are treated as one unit using Pi's `toolCall.id` / `toolResult.toolCallId`. A selection or saved block that would separate either side is rejected or left dormant. Existing blocks also stop applying if their originals enter the current protected initial/latest-user or recent-message/token region; they can reactivate once those messages are safely historical again. Size validation compares the complete rendered context, including big-pi's block header and wrapper, not just the bare summary.

## Session storage and manual verification

big-pi stores state in the adjacent `<session>.jsonl.big-pi/` folder, with an atomic `manifest.json` and immutable `blocks/B000001.json` chunk files. The manifest owns session identity, stable message refs, block relationships/lifecycle, metrics, and recovery state; each chunk owns its agent-written summary and source provenance. The manifest's `blocks` array is the committed chunk index. Empty sessions do not create the folder. New chunks are validated before the manifest references them, and unreferenced files left by interrupted writes are ignored. A damaged committed chunk falls back to raw context for its range and makes dependent higher tiers inapplicable without discarding other valid blocks.

Extensions that run independent agents can set `BIG_PI_AGENT_ID` to give each agent a separate context store. The extension exports `deleteBigPiAgentData(sessionFile, agentId)` to remove one agent's data. See [per-agent context storage](docs/CONFIGURATION.md#per-agent-context-storage).

Session refreshes with projected messages and explicit state changes (including successful compression) persist state; successful compression is persisted before the tool reports success. Context substitution itself does not write storage; checkpoint delivery and recovery transitions evaluated during a context request persist their cadence/diagnostics. Pi hosts may create provisional sessions; big-pi does not integrate with or identify Pi-vot's session-creation policy.

### Pi-vot on-disk contract

- `manifest.json` is versioned by integer `schemaVersion`; the current version is `1`.
- Its `blocks` array is the committed index. Every entry has `blockId`, `tier`, `chunkPath`, and `sha256`; `chunkPath` is a relative POSIX path inside the session's dedicated storage folder (currently `blocks/<filename>.json`).
- Count committed chunks from manifest entries, including dormant, superseded, and damaged/missing chunks. Do not count temporary or unreferenced files.
- Total big-pi disk usage includes all regular files under the dedicated folder, including the manifest, committed chunks, and temporary/unreferenced files. Do not follow symlinks.
- Validate a chunk's SHA-256 against its index entry before consuming it. Never infer committed chunks by scanning `blocks/`.

The Pi JSONL transcript remains authoritative and is never rewritten. See [Architecture](docs/ARCHITECTURE.md) and [Diagnostics](docs/DIAGNOSTICS.md) for the complete chunk shape and recovery behavior.

To verify a real compression, start a Pi/Pi-vot session with the extension enabled, complete enough work to exceed `minCompressRangeChars`, and run `/big-pi compact`. Confirm that the active model discovers sources, calls `big_pi_compress` with one of the shapes above and its own summary, and receives `Compression applied as ...`. Then run `/big-pi blocks` and `/big-pi status`, and continue the conversation to confirm the summary is present in context. For hierarchy testing, first create multiple Tier-1 blocks and request a promotion. Emergency recovery likewise needs a configured model and real context pressure; mocked tests do not establish a live LLM integration result.

big-pi has no third-party runtime dependencies. It supports installation from a local package directory, including controlled and air-gapped deployment without target-side npm installation or TypeScript compilation.

- [Installation and first run](START_HERE.md)
- [Configuration reference](docs/CONFIGURATION.md)
- [Diagnostics and troubleshooting](docs/DIAGNOSTICS.md)
- [Architecture](docs/ARCHITECTURE.md)
