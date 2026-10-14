# Configuration

big-pi reads optional JSON configuration from `~/.pi/big-pi.json`. Set `BIG_PI_CONFIG` to use another file. Missing/invalid configuration values produce warnings and safely fall back to defaults; a malformed file is ignored as a whole.

## Example

```json
{
  "nudge": {
    "mode": "percentage",
    "growthTriggerTokens": 50000,
    "thresholdPercentage": 75,
    "repeatEveryPercentage": 5,
    "display": "used"
  },
  "emergency": {
    "enabled": true,
    "pressureThresholdPercentage": 85,
    "targetPercentageAfterCompression": 70,
    "maxAttemptsPerTurn": 2
  },
  "hierarchy": {
    "enabled": true,
    "minBlocksPerPromotion": 3,
    "tier2NudgeSummaryTokens": 20000,
    "tier3NudgeSummaryTokens": 20000
  },
  "minCompressRangeChars": 5000,
  "protectedRecentMessages": 5,
  "protectedRecentTokens": 5000,
  "debug": false,
  "contextDumpEnabled": true
}
```

## Precedence and environment overrides

Defaults are applied first, then the JSON file, then supported environment overrides. `BIG_PI_CONFIG` selects the file and has no JSON equivalent.

| Environment variable | Meaning |
| --- | --- |
| `BIG_PI_NUDGE_MODE` | `growth`, `percentage`, or `hybrid` |
| `BIG_PI_GROWTH_TRIGGER_TOKENS` | Positive integer growth interval; overrides nested and legacy JSON values |
| `BIG_PI_NUDGE_THRESHOLD_PERCENTAGE` | Percentage threshold from 0 through 100 |
| `BIG_PI_NUDGE_REPEAT_PERCENTAGE` | Repeat interval greater than 0 through 100 |
| `BIG_PI_NUDGE_DISPLAY` | `used` or `remaining` |
| `BIG_PI_EMERGENCY_ENABLED` | `true`/`1`/`yes` or `false`/`0`/`no` |
| `BIG_PI_PRESSURE_THRESHOLD_PERCENTAGE` | Emergency pressure threshold, 0 through 100 |
| `BIG_PI_TARGET_PERCENTAGE` | Emergency target, 0 through 100 and below the pressure threshold |
| `BIG_PI_MAX_EMERGENCY_ATTEMPTS` | Integer from 1 through 5 |
| `BIG_PI_MIN_COMPRESS_RANGE_CHARS` | Positive integer minimum source size |
| `BIG_PI_AGENT_ID` | Optional stable agent identifier; stores this agent's context in a separate session directory |
| `BIG_PI_DEBUG` | `true`/`1`/`yes` or `false`/`0`/`no` |

Percentage JSON values accept up to six decimal places. For legacy compatibility, top-level `growthTriggerTokens` and `emergencyContextUtilization` (a fraction from greater than zero through 1) remain accepted. Nested `nudge.growthTriggerTokens` takes precedence over the legacy growth field; the environment override takes precedence over both. The legacy emergency fraction is used only when no `emergency` object exists.

## Nudge modes

| Setting | Default | Description |
| --- | ---: | --- |
| `nudge.mode` | `percentage` | `growth`, `percentage`, or `hybrid` |
| `nudge.growthTriggerTokens` | `50000` | Provider-measured context growth interval; advisory cadence, not a chunk size |
| `nudge.thresholdPercentage` | `75` | First percentage checkpoint; may be 0 |
| `nudge.repeatEveryPercentage` | `5` | Checkpoint spacing; must be positive |
| `nudge.display` | `used` | Model-facing percentage wording: used or remaining |

- **growth** nudges at configured provider-measured context growth intervals.
- **percentage** nudges at threshold checkpoints, repeating at the configured interval.
- **hybrid** nudges when either cadence is due, with at most one advisory per model turn.

Nudge and emergency thresholds use the latest provider-reported prompt usage from a completed model response. Big Pi does not use its serialized-message token estimate to trigger them. Until a provider usage report exists, percentage and emergency checks are unavailable. The denominator is Pi's reported nominal context window; the extension API does not provide a separate usable window or Pi's native reserve, so Big Pi does not guess one. If the window is unavailable, percentage nudging is unavailable; growth nudging can still use provider-reported token counts.

Calculations are not clamped. If provider-reported use is greater than the reported window, remaining percentage becomes negative (for example, 107% used means -7% remaining). `display` only affects model-facing wording. A normal nudge is advisory and leaves task tools available; only the higher emergency threshold starts Big Pi's bounded compression phase.

## Hierarchy

| Setting | Default | Description |
| --- | ---: | --- |
| `hierarchy.enabled` | `true` | Enables Tier-2 and Tier-3 promotion discovery |
| `hierarchy.minBlocksPerPromotion` | `3` | Minimum same-tier blocks for promotion; hard minimum is 2 |
| `hierarchy.tier2NudgeSummaryTokens` | `20000` | Advisory threshold for applicable Tier-1 summary mass |
| `hierarchy.tier3NudgeSummaryTokens` | `20000` | Advisory threshold for applicable Tier-2 summary mass |

Hierarchy nudges are advisory. Tier 1 covers raw message ranges, Tier 2 promotes Tier-1 blocks, and Tier 3 promotes Tier-2 blocks. Tier 3 is the maximum supported level.

## Emergency handling

| Setting | Default | Description |
| --- | ---: | --- |
| `emergency.enabled` | `true` | Enables bounded model-driven pressure and overflow recovery |
| `emergency.pressureThresholdPercentage` | `85` | Emergency threshold against provider-reported prompt usage and Pi's nominal window |
| `emergency.targetPercentageAfterCompression` | `70` | Requested post-compression target; must be below threshold |
| `emergency.maxAttemptsPerTurn` | `2` | Bounded attempts, configurable from 1 to 5 |

Emergency compression uses the normal active-agent tools; Big Pi does not generate summaries itself. When provider-reported input/cache/output usage reaches the emergency threshold, Big Pi starts the bounded compression phase before the next model request. After compression, it waits for the next provider usage report before deciding whether the target was met. If recovery is unsafe, unavailable, or exhausted, Big Pi yields to Pi-native compaction. When no context window is available, percentage/reclaim calculations remain unavailable, but an explicit Pi overflow event can still invoke recovery. A user-requested Pi compact action is routed to Big Pi's normal active-agent compression flow while Big Pi owns the session.

## Other settings

| Setting | Default | Description |
| --- | ---: | --- |
| `minCompressRangeChars` | `5000` | Minimum source character count offered/accepted for compression |
| `protectedRecentMessages` | `5` | Recent compressible messages protected from compression |
| `protectedRecentTokens` | `5000` | Recent-token tail protected from compression |
| `debug` | `false` | Enables verbose debug logging |
| `contextDumpEnabled` | `true` | Allows `/big-pi dump-context` |

## Per-agent context storage

By default, Big Pi uses the existing `<session>.jsonl.big-pi/` directory. When `BIG_PI_AGENT_ID` is set, Big Pi stores that process's manifest, blocks, and debug events under `<session>.jsonl.big-pi-agents/<agent-key>/`. The key is a SHA-256 hash of the supplied ID, so agent IDs cannot create paths outside the session directory. Keep an ID stable when resuming the same agent context; use a different ID for an independent subagent. Omitting the variable preserves the default storage path and existing session data.

The extension entry point exports `deleteBigPiAgentData(sessionPath, agentId)` to remove only one agent's manifest, blocks, and debug log; `deleteAllBigPiAgentData(sessionPath)` removes all agent-specific contexts for that transcript. Both are synchronous and return whether any data was removed. They do not delete the default/main Big Pi directory or Pi's transcript. For example:

```js
import { deleteBigPiAgentData } from "<big-pi-package-path>/index.js";

deleteBigPiAgentData(sessionFile, agentId);
```

Pi-vot removes the complete `.big-pi-agents` directory when deleting a session, including data whose agent ID it does not know.

The token counts are estimates, not model-tokenizer counts. See [Diagnostics](DIAGNOSTICS.md) for metric meanings and [Architecture](ARCHITECTURE.md) for behavior.
