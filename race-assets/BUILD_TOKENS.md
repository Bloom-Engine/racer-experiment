# Token usage: creating the asset set

How many tokens Claude Code used to produce this repository: the scripts in `asset-src/`, the generated
`assets/`, and commit `2fa703e`.

**Source:** the per-call `usage` records in the Claude Code session transcript
(`~/.claude/projects/-Users-<user>-projects-racer/6d7c8b5e-f829-49e8-a7bc-797256645224.jsonl`). The figures are
added up from that log, not estimated. Each API call is counted once (streamed content blocks that share a
message id are de-duplicated). The count covers the session from the prompt up to the final summary. Writing
this file is not included.

| | |
|---|---|
| Model | `claude-opus-5-5` (Claude Code CLI) |
| Session | 2026-11-09 03:52:59 → 04:26:44 UTC (**≈ 34 min** wall clock) |
| API calls (model turns) | **63** (parallel tool calls in one turn count as one call) |
| Subagents | none |

## Totals

| Token type | Tokens |
|---|---:|
| Input, uncached | 128 |
| Input, cache write | 246,667 |
| Input, cache read | 10,200,597 |
| **Input total (context processed)** | **10,447,392** |
| **Output** (code, text and reasoning) | **191,382** |
| **Grand total** | **10,638,774** |

* Around 98 % of the input was **cache reads**: each turn re-reads the growing conversation from the prompt
  cache. Only about 247k input tokens were ever newly written to the cache.
* The context grew from 42.5k tokens on the first call to **274k** on the last, about 166k per call on average.
* Output is 1.8 % of the total. It includes all of `asset-src/` (4,622 lines across 17 files: scripts,
  schema, asset README), the root README, and the model's reasoning.

## Approximate breakdown by phase

Each call is assigned to a phase by the files and commands in its tool calls, so the boundaries are heuristic.

| Phase | Calls | Input (incl. cache) | Output |
|---|---:|---:|---:|
| Setup, tool discovery, geometry/glTF/texture libraries | 12 | 835,598 | 42,367 |
| Track layout (centreline design and iteration) | 2 | 194,262 | 1,557 |
| PBR textures | 1 | 99,395 | 9,173 |
| Sky | 6 | 752,615 | 5,473 |
| Audio synthesis | 3 | 378,734 | 9,456 |
| UI icons and font | 3 | 407,929 | 5,835 |
| Car (model, previews, fixes) | 8 | 1,329,227 | 31,884 |
| Track, scenery, racing line, minimap | 11 | 2,233,459 | 46,620 |
| Manifest, schema, glTF validation, verification | 8 | 1,806,949 | 27,536 |
| Makefile, READMEs, reproducibility fix, commit | 9 | 2,409,224 | 11,481 |
| **Total** | **63** | **10,447,392** | **191,382** |

Later phases cost more input per call because each call re-reads the whole conversation so far, not because
the work was harder. Output tokens are the better measure of how much was written in each phase.

## Notes

* No dollar cost is given here, because pricing depends on the plan and the rates in effect. In Claude Code,
  `/cost` (or `/usage`) shows the cost for the current session.
* The asset build itself (`make assets`, about 45 s) uses no tokens. The generators are plain scripts, so
  rebuilding costs nothing.
