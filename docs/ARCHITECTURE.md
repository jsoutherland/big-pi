# Architecture

big-pi is a standalone JavaScript Pi extension. Its package declares `./index.js` through Pi's `pi.extensions` package field and relies on supported extension APIs. It requires no third-party runtime dependencies.

## Pi lifecycle integration

The extension registers `big_pi_compression_sources` and `big_pi_compress` tools plus `/big-pi` commands. The active model chooses semantic source boundaries and creates every summary. Source discovery returns candidate IDs bound to a current eligible raw range or same-tier block run; the compression engine resolves and revalidates that candidate. Growth/percentage/hybrid nudges and hierarchy/emergency prompts are advisory inputs to that same active agent; no hidden summarizer or automatic range selection exists.

The `context` hook correlates model-visible messages with Pi's `sessionManager.buildSessionProjection()` and substitutes applicable summaries. Pi's context event lacks source-entry IDs, so matching uses projection order and message fingerprints; a mismatch leaves context unchanged for that request. `before_agent_start` adds nudge guidance using the supported system-prompt result.

`session_before_compact` covers native `/compact` and automatic compaction. While Big Pi owns the session, a manual compact request is cancelled and routed to Big Pi's normal active-agent compression flow. Big Pi intercepts one automatic threshold request when no emergency compression phase is active; if Pi requests threshold compaction again without a committed block, Big Pi yields to Pi's native fallback. Measured emergency pressure starts Big Pi's bounded compression phase. Reaching its prompt budget stops new compression tool calls but keeps task tools gated until the agent response settles; then it yields if no block was committed. Phase diagnostics separate context requests, compression calls, and failed calls. Compaction lifecycle events track fallback completion/failure. Exact failed-prompt replay is not exposed by the extension API.

## Manifest, chunks, and stable references

The Pi JSONL transcript is authoritative and never rewritten. Each session's dedicated storage folder is adjacent at `<session>.jsonl.big-pi/`, containing `manifest.json` and `blocks/` chunk files. The manifest uses `schemaVersion: 1`; writes use a temporary manifest and atomic replacement. No previous single-sidecar format is migrated or read.

The manifest owns producer/session identity, message-ref records and counters, block-index relationships and lifecycle (`sourceBlockIds`, `supersedesBlockIds`, `supersededByBlockId`, status, timestamps), metrics, compression cadence, and recovery state. Its `blocks` array is the committed index; each entry exposes `blockId`, `tier`, relative `chunkPath`, and the chunk's SHA-256, as well as the hierarchy/lifecycle metadata. Large source provenance and summaries are not duplicated in the index.

Each immutable chunk is a JSON object with `schemaVersion: 1`, `blockId`, `summary`, `summaryTokensEstimate`, and `provenance`. Provenance owns Tier-1 `sourceMessageRefs`, `sourceEntryIds`, `sourceProjectionEntryIds`, and `sourceLineage` fingerprints, plus `effectiveOriginalMessageRefs`, `sourceRefRange`, `sourceMessageCount`, `sourceCharCount`, and direct/transitive source-token estimates. Higher-tier provenance retains ordered original refs and estimates while child relationships remain in the manifest. The index's `sha256` is over the exact UTF-8 chunk bytes.

New chunks are created exclusively and validated before the manifest references them. Existing committed chunk files are immutable; the manifest is committed atomically only after all new chunks validate. Orphaned files from interrupted writes are ignored and never adopted by scanning. A missing, malformed, symlinked, or checksum-invalid committed chunk is retained in the index and marked damaged locally: raw context for its range stays visible, dependent higher-tier representations are inapplicable, and unrelated/lower-tier valid blocks continue. Invalid manifests, unsafe paths, or untrusted session identity fail open for the whole session. Warnings are deduplicated by damaged block/reason.

big-pi assigns stable monotonic message refs to Pi session entries. Blocks retain source refs, projection/entry lineage, fingerprints, summary, estimates, and lifecycle/supersession relationships. Tier-1 blocks directly identify original messages. Higher tiers identify their direct child blocks and ordered transitive original refs.

## Tiers, lineage, and supersession

- **Tier 1** summarizes one contiguous eligible raw-message range.
- **Tier 2** promotes a contiguous range of applicable Tier-1 blocks.
- **Tier 3** promotes a contiguous range of applicable Tier-2 blocks.

Tier 3 is the supported maximum. The active model supplies ranges and summaries; the engine validates eligibility, current projection protections, tier consistency, contiguity, lineage, minimum size, and full transformed-context reduction including the rendered block header and wrapper.

Each block tracks direct input estimate, transitive original-source estimate, and summary estimate separately. Creating a parent records explicit supersession but retains child blocks and history. Rendering selects exactly one highest applicable representation per source range; when a parent is unavailable, applicable descendants or raw originals remain visible.

Assistant `toolCall.id` values and matching `toolResult.toolCallId` values form indivisible compression units. Discovery omits exchanges that cross a protected/covered boundary; requested raw ranges, hierarchy sources, and saved blocks are checked against those same IDs. If a block would leave a call without its result (or vice versa), it is inapplicable and the original messages remain in context.

## Branch and projection applicability

A block is usable only when all original source refs exist in the current Pi projection, are contiguous and ordered, match saved fingerprints, do not intersect the current initial/latest-user and recent-message/token protection set, and preserve complete tool-call/result pairs. Higher-tier blocks additionally require applicable descendants and valid transitive lineage, so a parent cannot bypass newly protected or unsafe descendants. A missing source, changed message, alternate branch, or changed protection boundary makes a block locally inapplicable without globally invalidating its lifecycle; raw content or valid lower-level blocks remain visible. Returning to a compatible branch or protection configuration restores applicability.

## Nudges

Growth and percentage cadence use provider-reported prompt input plus generated output tokens from a completed response, not the serialized-message estimate. This measures context after the completed turn so a long generated response can cross a threshold before the next request. A normal nudge is advisory and leaves task tools available. Cadence is session/branch-projection scoped and persisted in the manifest. Percentages are unclamped; no measurement or window means no percentage calculation, while growth mode can use measured token deltas without a window.

## Emergency pressure and overflow

When measured usage reaches the higher emergency threshold, the active agent receives a bounded high-priority request to compress eligible consumed history before its next model request. After compression, Big Pi waits for a fresh provider usage report before deciding whether it met the target. Pi overflow invokes a bounded emergency path; Big Pi prefers raw eligible material and may use a qualified same-tier promotion when raw material is unavailable. It does not create summaries itself. Unsafe/no-range/exhausted failures yield native compaction ownership to Pi. Runtime attempt counters are not resumed after restart; persistent lifecycle records whether native fallback is pending, completed, or failed.

## Failure philosophy

Trusted state is required before substitution or interception. Corrupt/unsupported persistent state disables big-pi for that session and allows Pi fallback. A transient context correlation/projection mismatch returns original messages and retries on later requests rather than poisoning the session. Logging and UI notification are best-effort and never prerequisites for session availability.
