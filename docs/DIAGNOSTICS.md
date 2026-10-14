# Diagnostics

## Commands

- `/big-pi status` — state health, compaction ownership, native attempts, emergency lifecycle, current projection, nudge cadence, and context metrics.
- `/big-pi blocks` — persisted blocks, tier, child/original counts, ref ranges, and supersession.
- `/big-pi inspect <block-id>` — one block's lineage, applicability, estimates, supersession, and summary.
- `/big-pi dump-context` — writes a readable projection/substitution dump under `~/.pi/big-pi-dumps/`. Dumps may contain sensitive conversation content; handle them accordingly.

The best-effort log is `~/.pi/big-pi.log`; it rotates at approximately 1 MiB to `.1`. Logging failures do not affect session availability. `BIG_PI_LOG_PATH` can redirect it. The config path is `~/.pi/big-pi.json`, unless `BIG_PI_CONFIG` selects another file. Each session's storage folder is `<session>.jsonl.big-pi/`, containing `manifest.json` and `blocks/` chunks.

`/big-pi dump-context` writes under `~/.pi/big-pi-dumps/` by default; `BIG_PI_DUMP_DIR` can redirect that directory. The benchmark sets both path variables to locations inside each result folder and lists them in `summary.json`, so development logs and any context dumps stay with that run instead of mixing into the normal Pi log folder.

When `BIG_PI_DEBUG` is `1` or `true` (case-insensitive), big-pi also writes a concise JSONL event log beside each transcript as `<session>.jsonl.big-pi-debug.jsonl`. It retains the full event history rather than truncating at a byte limit. Events contain lifecycle names and compact metadata only; prompts, summaries, and tool arguments are excluded. With `BIG_PI_AGENT_ID`, the event log is stored in that agent's `.big-pi-agents/<agent-key>/debug.jsonl` directory with its context blocks. Pi-vot removes all agent-specific data when deleting the corresponding session.

An empty session projection does not create a storage folder, and an empty context projection does not rewrite an existing manifest. Successful compression is saved before the tool reports success. Pi/Pi-vot may manage provisional session IDs; big-pi does not change that host behavior.

## Reading token metrics

All local token counts are estimates based on serialized UTF-8 content divided by three, not the active model's tokenizer.

- **Raw/projected tokens** (`projectedOriginalRawContextTokensEstimate`): estimate for original messages in Pi's current session projection, before substitutions. This does not mean every projected message is eligible for compression.
- **Effective tokens** (`effectiveTransformedContextTokensEstimate`): estimate for all messages actually passed to the model after applicable block substitutions.
- **Direct source tokens** (`applicableBlockDirectSourceTokensEstimate`): estimated immediate input mass of applicable blocks: raw input for Tier 1, child summaries for higher tiers.
- **Transitive original-source tokens** (`sourceTokensRepresentedByApplicableBlocks`): raw original history represented by the highest applicable, non-overlapping blocks. Higher-tier descendants are not double-counted.
- **Summary tokens** (`blockSummaryTokensEstimate`): estimated current model-context footprint of applicable summaries.

The provider usage in `/big-pi status` comes from the latest completed assistant response (`input + cacheRead + cacheWrite + output`), measuring context after the response; it is separate from the local serialized-message estimate. Nudge and emergency decisions use this provider-reported value and the reported nominal context window only. Until a completed response provides usage, those threshold checks remain unavailable. There is no separate reserve-adjusted usable-window API. Negative remaining percentages and over-budget measurements are preserved, not clamped. Debug logs record provider input/output counts and the next threshold checkpoint, including which checkpoint triggered emergency pressure.

## Ownership, fallback, and emergency status

While the manifest/chunks/projection are healthy, `Compaction owner: big-pi` means big-pi cancels Pi's ordinary native compaction requests. Native status distinguishes interception being active from an actual cancellation observed. An invalid manifest or unsafe transformation yields ownership to Pi (`Compaction owner: Pi` / `Pi native compaction: allowed`). A damaged chunk is handled locally where safe.

Emergency pressure is model-driven and bounded. Status may show `NORMAL`, `PRESSURE`, or `OVERFLOW`, recent attempts, reclaim needed from the provider measurement, and fallback lifecycle. After Big Pi compression, the old provider count is discarded; recovery is checked when a later completed response reports the new context usage. If the compression prompt budget is reached, Big Pi blocks further compression calls and keeps task tools gated until the active response settles; it then yields to Pi if no block committed. Phase events separately count context requests, compression calls, and failed calls. For ordinary threshold compaction, Big Pi intercepts at most one request without compression progress before yielding repeated requests to Pi. Historical native compaction entries remain Pi transcript history and are not claimed as Big Pi output.

Emergency instructions direct the active model to discover eligible sources, supply its own summary, and correct validation errors rather than repeating the same request. Mocked tests cover successful block persistence/context transformation, bounded retries, and native fallback. For a live check, run with a configured model, allow pressure/overflow guidance to occur, verify the model discovers sources and invokes `big_pi_compress`, then inspect `/big-pi blocks` and `/big-pi status`. A live model/provider integration is not demonstrated by the automated tests.

## Inspecting storage manually

The adjacent storage folder is `<session>.jsonl.big-pi/`. `manifest.json` is readable JSON with current `schemaVersion: 1`; inspect its session identity, `messageRefs`, `compression`, `recovery`, and `blocks` committed index without editing it while Pi is running. Each index entry exposes `blockId`, `tier`, relative `chunkPath`, and `sha256`; chunks live under `blocks/` and contain the summary and source provenance. The hash is SHA-256 over the chunk's exact bytes. There is no migration from the previous `.big-pi.json` single-file format.

The manifest index—not a directory scan—is authoritative for committed chunk counts. Dormant, superseded, and damaged/missing chunks remain indexed and counted. Temporary or unreferenced files are not committed chunks, but count toward disk usage if they are regular files inside the storage folder. Symlinks are not followed. Back up the complete storage folder and transcript before manual repair. The Pi JSONL transcript remains authoritative.

If a chunk is missing, malformed, symlinked, or fails its hash, big-pi keeps the manifest entry, preserves raw context for its source range, and makes dependent higher-tier summaries inapplicable. Valid unrelated blocks and independently applicable descendants may still be used. Restore a chunk only from a trusted backup; do not manually edit the manifest index or rename another chunk into place.

## Troubleshooting

### Manifest malformed

Check the Pi log for a parse/integrity error and retain a backup before taking action. big-pi fails open for that session and allows Pi-native compaction; it does not rewrite the transcript or silently recreate trustworthy provenance.

### Unsupported schema

Check `schemaVersion` and the installed extension version. An unsupported manifest version disables big-pi state for that session and yields compaction ownership to Pi; preserve the complete storage folder for recovery or a later compatible version.

### Native Pi fallback

Run `/big-pi status` and check ownership, overflow reason, last fallback state, attempt count, and `~/.pi/big-pi.log`. Pi may perform its normal compact-and-retry. If overflow recovery interrupts a model request, big-pi directs Pi to continue the active task from retained transcript and summaries without asking the user whether to proceed. The public extension API cannot replay the exact failed model request; if essential task details are genuinely absent from retained context, Pi may need those details to continue safely.

### Percentage denominator unavailable

Pi did not provide a positive context window through `getContextUsage()` or the model context. Percentage mode cannot calculate checkpoints; hybrid continues using growth cadence. big-pi does not invent a denominator or infer Pi's native reserve.

### Extension not loading

Confirm that the package path still exists and contains `package.json`, `index.js`, and `lib/big-pi.js`. Check that the manifest points to `./index.js`, the Pi settings still reference the correct local path, and Pi was restarted after replacing package contents. Review Pi's startup output for extension errors.

### Local package path missing

Restore the release directory at the exact configured path or remove the stale package reference with Pi's `pi remove <source>` command. Local packages are loaded by path, not copied to a managed install directory. Reinstall with `pi install <permanent-local-path>` if the path reference was removed.
