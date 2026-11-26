# Browser comparison: Three.js vs Bloom + WASM — 2026-11-09T17-52-23 (SMOKE TEST, not a measurement)

Google Chrome 156.0.8078.80, Apple M1 Max (10 cores, 64 GB), macOS 25.5.0. Window 1280x800, DPR forced to 1. 1 interleaved round(s); cells are **median** (min–max). CPU: % of one core, summed over Chrome's whole process tree. RAM: macOS phys_footprint, summed.

| Metric | Chrome, about:blank (baseline) | Three.js (WebGL) |
|---|---|---|
| Race CPU total (% of 1 core) | – | 64.0 |
| Race CPU page | – | 27.6 |
| Race CPU GPU proc | – | 31.3 |
| Race CPU per frame (ms, all procs) | – | 5.34 |
| Race CPU per frame (ms, page only) | – | 2.31 |
| Race fps | – | 115.2 |
| Race frame time p99 (ms) | – | 9.3 |
| Race frames > 25 ms | – | 5 |
| Race RAM total median (MB) | – | 1002 |
| Race RAM total max (MB) | – | 1045 |
| Race RAM page median (MB) | – | 348 |
| Race RAM GPU proc median (MB) | – | 471 |
| Race RAM page peak (MB) | – | 269 |

GPU: –

Race ends: threejs#1 cap 30s

Notes: the two builds do not render identical content (Bloom has no tyre smoke/skid marks; renderers and post-effects differ), so this compares the two *apps as built*, not the engines in isolation. If fps differs between the two, compare "CPU per frame" rather than CPU %. Logs: logs/.
