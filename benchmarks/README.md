# Big Pi Benchmark

This optional benchmark utility is shipped with Big Pi. It sends a fixed sequence of prompts to one Pi RPC process, with a new empty project folder and session directory for every run.

It records Pi compaction events and durations, Big Pi compression attempts and other Big Pi tool calls, provider-reported token usage by turn category, committed blocks by tier/status, context usage around each prompt, prompt completion, timeout/stuck state, and Pi stderr. It also saves Big Pi's development log and any context dumps created during the run under that run's result folder. Prompts, model responses, and context dumps can contain sensitive content, so keep the results directory private.

The console prints timestamped lines when Pi compaction and Big Pi compression start and finish. Prompt progress uses aligned columns for the prompt, status, and reported context usage (`[current / max tokens]`). Both token counts are right-aligned in seven-character fields so values up to `999,999` stay aligned.

## Requirements

- Node.js 22 or newer
- Pi installed and available as a command (or pass `--pi`)
- A configured Pi model/provider

The runner uses only Node.js built-in modules. No npm install or additional dependency is required.

## Configure prompts

Copy `benchmarks/examples/prompts.json` and replace the examples with your fixed prompt sequence. Each prompt can be a string or an object with `id` and `text`; prompt text can be multiline JSON strings.

For a longer, more context-intensive version of the radar application benchmark, use `benchmarks/examples/radar-equations-prompts-verbose.json`. It breaks the work into 20 detailed implementation, testing, and review steps. This is intended to increase context use and the opportunity for higher-tier compression; whether it creates a Tier 3 block still depends on the chosen Big Pi configuration, generated conversation, and model behavior.

## Run a benchmark

From the Big Pi repository or extracted release folder:

```sh
node benchmarks/benchmark.mjs \
  --prompts ./benchmarks/examples/prompts.json \
  --extension ./index.js \
  --config ./benchmarks/examples/baseline-config.json \
  --model lmstudio/your-model-id \
  --label baseline
```

On Windows PowerShell:

```powershell
node .\benchmarks\benchmark.mjs --prompts .\benchmarks\examples\prompts.json --extension .\index.js --config .\benchmarks\examples\baseline-config.json --model lmstudio/your-model-id --label baseline
```

`--config` accepts a Big Pi JSON config file. The runner copies that file byte-for-byte into each run directory as `big-pi-config.json`, records its SHA-256 hash, and points `BIG_PI_CONFIG` at the copy. It does not edit `~/.pi` or project settings. If omitted, the included baseline config is copied instead. Inherited `BIG_PI_*` tuning variables are cleared so they cannot silently override the saved config. `BIG_PI_DEBUG=1` is set for the run to capture the per-session event log and detailed development log. `BIG_PI_LOG_PATH` and `BIG_PI_DUMP_DIR` point into the run result folder, isolating the global log and `/big-pi dump-context` output from other Pi sessions.

## Run the 80k context configuration matrix

The included `config-sets/80k-context.json` contains 11 configurations that compare growth, percentage, and hybrid nudges; thresholds and repeat intervals; used versus remaining wording; and an earlier emergency threshold. It assumes the selected Pi model reports an 80,000-token context window. The file labels the target window but does not change the model's context limit. Check `effectiveModel.contextWindow` in each result to verify the actual value.

To run the radar prompt set across every configuration, use the command for your shell. In Git Bash, use forward slashes for repository paths and the Windows project directory:

```bash
node ./benchmarks/benchmark.mjs \
  --prompts ./benchmarks/examples/radar-equations-prompts.json \
  --extension ./index.js \
  --all-configs \
  --runs-dir ./benchmark-results/radar-80k \
  --projects-dir C:/tmp/big-pi \
  --model "lmstudio/qwen/qwen3.5-9b" \
  --timeout-minutes 120
```

The equivalent Windows PowerShell command uses backticks for line continuation and backslashes for repository paths:

```powershell
node .\benchmarks\benchmark.mjs `
  --prompts .\benchmarks\examples\radar-equations-prompts.json `
  --extension .\index.js `
  --all-configs `
  --runs-dir .\benchmark-results\radar-80k `
  --projects-dir C:\tmp\big-pi `
  --model "lmstudio/qwen/qwen3.5-9b" `
  --timeout-minutes 120
```

`--all-configs` is shorthand for the shipped matrix. Use `--config-set FILE` for your own config set; each entry needs a unique `id` and either a `config` object or a `configFile` path relative to the set file. `--config-set` and `--all-configs` cannot be combined with `--config`. The timeout applies to the whole configuration run, including its full prompt sequence; the default is 120 minutes. Use `--runs N` to repeat every matrix entry in fresh project/session directories.

To include Pi's native compaction as a baseline in a grid, add `--include-stock`:

```sh
node ./benchmarks/benchmark.mjs \
  --prompts ./benchmarks/examples/radar-equations-prompts.json \
  --extension ./index.js \
  --all-configs \
  --include-stock \
  --runs 3 \
  --runs-dir ./benchmark-results/radar-stock-comparison \
  --projects-dir C:/tmp/big-pi \
  --model "lmstudio/qwen/qwen3.5-9b" \
  --timeout-minutes 60
```

The added `stock-pi` entry runs the same prompts/model with `--no-extensions`, no explicit extension, no Big Pi config, and no inherited `BIG_PI_*` settings. This remains isolated if Big Pi is installed in Pi's normal extension locations: extension auto-discovery is disabled for every benchmark process, and only Big Pi grid entries load the explicit `--extension`. A standalone stock run uses `--stock-pi` instead of `--extension` and `--all-configs`/`--config-set`. Check `piAutoCompactionEnabled` in its `summary.json` to confirm Pi's native auto-compaction is enabled for the comparison.

To run Billion Context Pi by itself, pass its extension entry file with `--billion-context-pi`. The benchmark disables extension discovery, loads only that file, clears inherited `BIG_PI_*` variables, and reads the session's `<session-file>.acp.json` sidecar after the run. It records sidecar detection/validation status, total blocks, and T1/T2/T3 counts in `summary.json` and the console summary. For a config-grid comparison, add `--include-billion-context-pi PATH` alongside `--include-stock`; the BCP case uses the same prompts, model, repeats, and timeout as the Big Pi and stock cases. Use the actual entry file from your local Billion Context Pi installation/source checkout.

Example standalone BCP run:

```sh
node ./benchmarks/benchmark.mjs \
  --prompts ./benchmarks/examples/radar-equations-prompts.json \
  --billion-context-pi /path/to/billion-context-pi/index.ts \
  --runs-dir ./benchmark-results/radar-bcp \
  --projects-dir C:/tmp/big-pi-bcp \
  --model "lmstudio/qwen/qwen3.5-9b" \
  --timeout-minutes 60
```

To add it to a Big Pi grid, keep the Big Pi `--extension` and grid arguments, then add `--include-stock --include-billion-context-pi /path/to/billion-context-pi/index.ts`. A valid BCP sidecar is identified by a `producer` beginning `billion-context-pi@` and `blocks` entries with unique IDs and tiers 1–3. Invalid or missing sidecars are reported with their status; malformed counts are left unavailable rather than guessed.

The matrix runs sequentially. Every configuration/run gets its own folder and `summary.json` plus a byte-for-byte config snapshot and hash. The results root gets an incrementally updated `matrix-summary.json` indexing each result. A Pi startup error, invalid config, or prompt timeout is recorded for that entry and the next configuration still runs. A prompt that settles after Pi reports an unrecovered compaction error is recorded as settled but failed; it does not count as a completed prompt or successful run. The command exits nonzero after the matrix finishes if any entry failed; check the index to see which ones and their result files.

If you interrupt a matrix with Ctrl-C, restart the same command with `--resume`. The runner keeps finished entries, removes the interrupted run folder and its project directory, and repeats that configuration/run in a fresh project. Resume checks the prompts, config set and referenced config files, extension, model, run count, and output directories. Timeout or other completed failures remain recorded and are not retried automatically. For example, append `--resume` to the Git Bash matrix command above.

`nudge.display: "used"` versus `"remaining"` changes advisory wording only; both use the same percentage threshold/checkpoint logic. Growth mode ignores percentage nudges, percentage mode ignores growth nudges, and hybrid mode advises when either cadence is due. The emergency pressure/target settings are separate from these advisory nudge modes.

Each run creates a uniquely named results folder under `./runs/` (or `--runs-dir`) containing an isolated `sessions/` directory, config snapshot, `events.jsonl`, `pi-rpc-stdout.jsonl`, `summary.json`, and Pi stderr output. Its separate, fresh project working directory is created under `C:\tmp\big-pi\` on Windows (or `/tmp/big-pi/` on other platforms). `--projects-dir` changes that location. The session transcript, Big Pi manifest/chunks, and Big Pi debug JSONL stay with the run's result files. Use `--runs N` to repeat the same prompt set N times; every repetition gets a unique project and session directory.

Pi starts with extension auto-discovery disabled and loads only the extension passed with `--extension`, preventing a globally installed Big Pi copy or another extension from changing the run. Pi still uses your configured model/provider credentials. The summary records the effective model and Pi's auto-compaction setting.

## Reading results

Open `summary.json` for a compact result. `estimatedCompactionTimeLostMs` is the union of observed Pi-native compaction intervals and `big_pi_compress` attempt intervals, avoiding double-counting overlap. `bigPiToolCalls.compressionAttemptTimeMs` includes successful, failed, and no-op attempts; `successfulCompressionTimeMs` includes only calls with a matching persisted `compression_applied` event; `otherToolTimeMs` reports source-discovery and other Big Pi tool durations; and `allBigPiToolTimeMs` reports their union. The legacy `compressionTimeMs` remains an alias for attempt time. Token usage is split under `modelContextUsage.usageByTurnCategory` into ordinary `work`, `compressionAttempt`, `otherBigPiTool`, and mixed-tool turns. Work-only context metrics continue to exclude Big Pi tool turns. These are provider-reported prompt/output counts; the benchmark cannot measure model reasoning time spent deciding to compress.

`completion.stuck` is set if Pi exits unexpectedly or a configuration run exceeds its timeout. `completion.settledPrompts` counts prompts where Pi became idle; `completion.completedPrompts` excludes prompts with unrecovered Pi compaction errors. Those prompt-level failures appear in `completion.promptFailures` and on the prompt progress line. When available, `completion.stateAtTimeout` records whether Pi still reported streaming or compacting. The partial session and logs are retained for diagnosis unless the interrupted entry is later replaced with `--resume`. The default timeout is 120 minutes per configuration run; change it with `--timeout-minutes`.

`contextLimitExceeded` flags a reported context usage above 100% or above the model's window. Big Pi's `committedBlocksByTier` counts all manifest blocks, including dormant or superseded entries; `committedBlocksByStatus` breaks down lifecycle state. `appliedBlocksByTier` counts successful compression calls during the run. Context values are Pi's reported estimates and may be unavailable until a response has completed.

The JSONL event file contains Pi RPC events, including message and tool events. It can include prompt/response content, so treat it as sensitive. The Big Pi debug file contains lifecycle metadata only.

Prompt step numbers use the total prompt count's width (`[ 1/20]`, `[10/20]`). The runner waits for `agent_settled` and confirms native state has no streaming, compaction, or pending messages before advancing, including queued recovery and model retries. Immediate cancelled compaction attempts are labelled once; all attempts remain in JSONL and `piCompactions.cancelledCount`. Windows open locks on appended log files are retried with bounded backoff; permanent errors are recorded as run failures.


## Compare results in a browser

Open benchmarks/compare.html in a browser and drop in one or more matrix-summary.json files. New matrix indexes contain inline metrics, so you do not need to load each run folder. The page compares repeated runs per configuration with sample-standard-deviation error bars, including separate work, compression-attempt, and other Big Pi tool token/time measures. It lists each run and its Tier 1/2/3 chunk counts and can export loaded observations as CSV. Select individual summary.json files to include runs from older matrix results that do not contain inline metrics. The page runs locally and does not upload result files.
