# Live provider usage check

This small, isolated benchmark checks whether Pi's completed ordinary assistant turns expose provider usage to Big Pi and the benchmark summary. The prompts explicitly ask for text-only replies to avoid repeating the earlier stalled run, where a placeholder prompt caused the model to launch a recursive `find /` command.

This check does not attempt Big Pi compression or context overflow. Its short prompt sequence should not reach either condition. Those need separate, deliberately configured tests after this baseline completes.

## Run from the Big Pi project root in Git Bash

First confirm the prompt file exists:

```bash
test -f ./benchmarks/live-provider-usage-check/prompts.json && echo "Prompt file found"
```

Then run:

```bash
node ./benchmarks/benchmark.mjs \
  --prompts ./benchmarks/live-provider-usage-check/prompts.json \
  --extension ./index.js \
  --config ./benchmarks/examples/baseline-config.json \
  --runs-dir ./benchmark-results/live-provider-usage \
  --projects-dir C:/tmp/big-pi-live-provider-usage \
  --model "lmstudio/qwen/qwen3.5-9b" \
  --timeout-minutes 10
```

The benchmark creates an isolated, empty project directory for the run. Do not replace the prompt path with `benchmarks/examples/prompts.json`; that file is a template containing instructions to edit prompts. These prompts should not require shell commands. If the model nevertheless starts a long or broad command, press Ctrl+C and keep the partial result folder for diagnosis.

## What a successful run should show

- All 3 prompts settle and the benchmark exits normally.
- `summary.json` reports `completion.completedPrompts: 3`.
- `modelContextUsage.workTurnsWithUsage` is at least 3, and `usageByTurnCategory.work` has provider prompt and output token totals.
- `usageByTurnCategory.compressionAttempt.turns` and `otherBigPiTool.turns` should be 0 for this short, no-tool check.
- `pi-rpc-stdout.jsonl` contains completed assistant `message_end` records with provider/model fields and nonzero usage where the provider reports it.

This confirms ordinary-turn measurement only. A zero compression count is expected here; it does not test whether compression calls are categorized correctly. No overflow or learned-window result should be expected from this run.

## Send back for review

After the benchmark exits, zip the one run folder (use the folder name printed after `Results:`):

```bash
cd ./benchmark-results/live-provider-usage
zip -r ../live-provider-usage-run.zip ./<run-folder-name>
```

Send `live-provider-usage-run.zip` and the benchmark's console output. It should contain `summary.json`, `events.jsonl`, `pi-rpc-stdout.jsonl`, the session transcript, `big-pi.log`, `run-state.json`, and the Big Pi debug JSONL. If the run does not settle, include the partial run folder and the last console lines instead. Do not include API keys or provider credentials.

For the next checks, also report the context window configured for this LM Studio model. Compression categorization requires a run that actually invokes Big Pi tools. Learned-window recovery requires a real provider overflow/error that explicitly states the context limit; this small prompt set will not create one.
