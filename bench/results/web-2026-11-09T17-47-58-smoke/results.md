# Browser comparison: Three.js vs Bloom + WASM — 2026-11-09T17-47-58 (SMOKE TEST, not a measurement)

Google Chrome 156.0.8078.80, Apple M1 Max (10 cores, 64 GB), macOS 25.5.0. Window 1280x800, DPR forced to 1. 1 interleaved round(s); cells are **median** (min–max). CPU: % of one core, summed over Chrome's whole process tree. RAM: macOS phys_footprint, summed.

| Metric | Chrome, about:blank (baseline) | Three.js (WebGL) | Bloom + WASM (WebGPU) |
|---|---|---|---|
| Load time (s) | – | 1.21 | 4.05 |
| Load CPU (CPU-s) | – | 1.50 | 5.22 |
| Idle CPU total (% of 1 core) | 1.4 | 39.5 | 98.7 |
| Idle CPU page | 0.1 | 15.1 | 56.2 |
| Idle CPU GPU proc | 0.1 | 19.0 | 36.5 |
| Idle fps | – | 120 | 120 |
| Idle RAM total (MB) | 379 | 968 | 1308 |
| Idle RAM page (MB) | 115 | 324 | 517 |
| Idle RAM GPU proc (MB) | 80 | 432 | 610 |
| Race CPU total (% of 1 core) | – | 4.7 | 96.0 |
| Race CPU page | – | 0.4 | 60.8 |
| Race CPU GPU proc | – | 0.2 | 33.3 |
| Race CPU per frame (ms, all procs) | – | 0.77 | 7.57 |
| Race CPU per frame (ms, page only) | – | 0.06 | 4.80 |
| Race fps | – | 57.5 | 119.6 |
| Race frame time p99 (ms) | – | 16.8 | 9.3 |
| Race frames > 25 ms | – | 5 | 2 |
| Race RAM total median (MB) | – | 350 | 1335 |
| Race RAM total max (MB) | – | 426 | 1370 |
| Race RAM page median (MB) | – | 113 | 531 |
| Race RAM GPU proc median (MB) | – | 81 | 619 |
| Race RAM page peak (MB) | – | 61 | 487 |

GPU: threejs: WebGPU apple metal-3, WebGL "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)"; bloom: WebGPU apple metal-3, WebGL "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)"

Race ends: threejs#1 cap 30s, bloom#1 cap 30s

Notes: the two builds do not render identical content (Bloom has no tyre smoke/skid marks; renderers and post-effects differ), so this compares the two *apps as built*, not the engines in isolation. If fps differs between the two, compare "CPU per frame" rather than CPU %. Logs: logs/.
