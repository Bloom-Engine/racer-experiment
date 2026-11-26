# Browser comparison: Three.js vs Bloom + WASM — 2026-11-09T17-53-20 (SMOKE TEST, not a measurement)

Google Chrome 156.0.8078.80, Apple M1 Max (10 cores, 64 GB), macOS 25.5.0. Window 1280x800, DPR forced to 1. 1 interleaved round(s); cells are **median** (min–max). CPU: % of one core, summed over Chrome's whole process tree. RAM: macOS phys_footprint, summed.

| Metric | Chrome, about:blank (baseline) | Bloom + WASM (WebGPU) |
|---|---|---|
| Race CPU total (% of 1 core) | – | 94.0 |
| Race CPU page | – | 59.9 |
| Race CPU GPU proc | – | 31.1 |
| Race CPU per frame (ms, all procs) | – | 7.52 |
| Race CPU per frame (ms, page only) | – | 4.79 |
| Race fps | – | 120.0 |
| Race frame time p99 (ms) | – | 9.3 |
| Race frames > 25 ms | – | 0 |
| Race RAM total median (MB) | – | 1331 |
| Race RAM total max (MB) | – | 1360 |
| Race RAM page median (MB) | – | 526 |
| Race RAM GPU proc median (MB) | – | 607 |
| Race RAM page peak (MB) | – | 461 |

GPU: –

Race ends: bloom#1 cap 30s

Notes: the two builds do not render identical content (Bloom has no tyre smoke/skid marks; renderers and post-effects differ), so this compares the two *apps as built*, not the engines in isolation. If fps differs between the two, compare "CPU per frame" rather than CPU %. Logs: logs/.
