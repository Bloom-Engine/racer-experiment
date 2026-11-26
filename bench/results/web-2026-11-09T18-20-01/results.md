# Browser comparison: Three.js vs Bloom + WASM — 2026-11-09T18-20-01

Google Chrome 156.0.8078.80, Apple M1 Max (10 cores, 64 GB), macOS 25.5.0. Window 1280x800, DPR forced to 1. 5 interleaved round(s); cells are **median** (min–max). CPU: % of one core, summed over Chrome's whole process tree. RAM: macOS phys_footprint, summed.

| Metric | Chrome, about:blank (baseline) | Three.js (WebGL) | Bloom + WASM (WebGPU) |
|---|---|---|---|
| Load time (s) | – | **0.56** (0.52–0.91) | **3.44** (3.35–3.49) |
| Load CPU (CPU-s) | – | **1.52** (1.35–1.73) | **4.99** (4.37–5.01) |
| Idle CPU total (% of 1 core) | **3.4** (3.0–3.5) | **35.1** (33.1–37.1) | **78.4** (77.5–82.5) |
| Idle CPU page | **0.0** (0.0–0.0) | **14.2** (12.6–14.7) | **47.7** (47.3–49.3) |
| Idle CPU GPU proc | **0.0** (0.0–0.0) | **17.0** (15.3–17.6) | **26.4** (26.1–28.7) |
| Idle fps | – | **120** (120–120) | **120** (120–120) |
| Idle RAM total (MB) | **363** (356–386) | **964** (957–1008) | **1315** (1310–1318) |
| Idle RAM page (MB) | **114** (114–115) | **326** (321–357) | **522** (520–522) |
| Idle RAM GPU proc (MB) | **84** (80–107) | **441** (435–451) | **603** (600–608) |
| Race CPU total (% of 1 core) | – | **55.6** (53.3–57.2) | **78.1** (77.4–82.7) |
| Race CPU page | – | **24.2** (22.8–25.2) | **51.8** (51.4–54.4) |
| Race CPU GPU proc | – | **27.7** (26.7–28.3) | **24.5** (24.1–26.4) |
| Race CPU per frame (ms, all procs) | – | **4.60** (4.41–4.74) | **6.47** (6.37–6.84) |
| Race CPU per frame (ms, page only) | – | **2.00** (1.89–2.09) | **4.28** (4.24–4.50) |
| Race fps | – | **120.0** (119.8–120.0) | **120.0** (119.9–120.0) |
| Race frame time p99 (ms) | – | **10.1** (9.3–10.3) | **9.9** (9.3–10.2) |
| Race frames > 25 ms | – | **0** (0–2) | **0** (0–0) |
| Race RAM total median (MB) | – | **994** (982–1003) | **1378** (1377–1389) |
| Race RAM total max (MB) | – | **1037** (1028–1060) | **1446** (1428–1459) |
| Race RAM page median (MB) | – | **333** (326–338) | **575** (574–576) |
| Race RAM GPU proc median (MB) | – | **469** (464–475) | **620** (616–631) |
| Race RAM page peak (MB) | – | **282** (276–285) | **525** (520–526) |

GPU: threejs: WebGPU apple metal-3, WebGL "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)"; bloom: WebGPU apple metal-3, WebGL "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)"

Race ends: threejs#1 finished 156s, bloom#1 finished 157s, bloom#2 finished 157s, threejs#2 finished 159s, threejs#3 finished 161s, bloom#3 finished 157s, bloom#4 finished 157s, threejs#4 finished 162s, threejs#5 finished 154s, bloom#5 finished 157s

Notes: the two builds do not render identical content (Bloom has no tyre smoke/skid marks; renderers and post-effects differ), so this compares the two *apps as built*, not the engines in isolation. If fps differs between the two, compare "CPU per frame" rather than CPU %. Logs: logs/.
