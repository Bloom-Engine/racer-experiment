# Token usage and time log

Model: Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code. Logged 2026-11-09.

Source: the per-response `usage` fields and timestamps in this session's transcript
(`~/.claude/projects/-Users-<user>-projects-racer-C-hybrid/d335e3e7-022a-43db-9565-bc86cfad5def.jsonl`),
summed once per API response (deduplicated by message id). The numbers cover everything from the
first prompt to the end of the work, including the iPhone runs, NOTES.md and HYBRID_FRICTION.md.
They don't include this logging step itself.

## Tokens

| Metric | Tokens |
|---|---:|
| API calls (model turns) | 138 |
| Output tokens (code, prose, tool calls, reasoning) | **156,452** |
| Input: uncached | 294 |
| Input: written to the prompt cache | 811,962 |
| Input: read from the prompt cache | 36,604,176 |
| **Input: total processed** | **37,416,432** |
| Context size at the last call | 441,065 |

- **Output (~156k)** is what the model generated. About 137 kB of authored files (~35k tokens) went into
  `src/`, `bloom/`, `scripts/`, NOTES.md and HYBRID_FRICTION.md. The rest is reasoning, tool commands
  and status messages.
- **Input (~37.4M)** is large because each of the 138 calls re-sends the whole conversation so far,
  including the Bloom/bridge source I read, build and test logs, and about ten 2560×1600 screenshots.
  About 98% of it was served from the prompt cache, which is billed far below fresh input. Only about
  812k tokens were new (cache writes).
- **Billing:** for authoritative numbers, run `/cost` (or `/usage`) in Claude Code.

## Time (UTC timestamps from the transcript)

| | |
|---|---:|
| First prompt | 10:38:58 |
| Last work before this log | 14:00:50 |
| **Wall clock** | **3 h 22 min** |
| Idle, waiting for the iPhone to be unlocked (12:32 → 13:40) | 1 h 08 min |
| **Active working time** | **≈ 2 h 14 min** |

Within the active time, roughly **1 h was spent waiting for compiles**: about 14 macOS builds at
2–2.5 min each (three.js is recompiled every time), and 4 iOS device builds of 5–8.5 min, two of which
failed (RCPC baseline, wrong runtime dir). The scripted test runs took ≈ 20 min, including the
3–4 min full-race runs on the Mac and the iPhone. This breakdown is estimated from the build and run
durations in the logs, not measured separately.

Milestones (UTC):
- 10:39 start: reading assets, the bridge, Bloom and Perry docs
- 11:05 first native frame (track, cars, HUD)
- 11:19 cars driving, after the wheel-ray layer and forward-axis fixes
- 11:38 full 3-lap autopilot race completes; wall-tunnel tests pass
- 11:54 drift, camera and effects tuned
- 12:32 iOS device build installed (launch blocked: phone locked)
- 13:40–14:00 on-device runs; mobile quality settings; 60 fps over a full race
