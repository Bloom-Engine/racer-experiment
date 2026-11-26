# Racer measurements 2026-11-09T12-09-08

Host: Apple M1 Max, 10 cores, 64 GB; load at start 145.4 / 221.1 / 219.5. Startup = median of 1 launches (run 1 = cold cache). Memory: RSS summed over the process tree (Chrome: all its processes); footprint = macOS phys_footprint (includes GPU/IOSurface memory).

| | exe | macOS .app | iOS .app | web | startup (median) | startup run 1 | idle RSS | idle footprint | max RSS (race) | peak footprint (race) | race |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A1 Three.js (web, Chrome) | – | – | – | 36.5 MB (code 0.2 MB gz) | 4.06 s (page only 2.54 s) | 4.06 s | 1287 MB | 1155 MB | – | – | –  |
| A2 Three.js → Perry/Bloom bridge | 57.8 MB | 93.6 MB | 102.7 MB | – | 3.05 s | 3.05 s | 333 MB | 905 MB | – | – | –  |
| B Bloom native (TS, Perry) | 22.6 MB | 71.1 MB | 75.9 MB | – | 3.07 s | 3.07 s | 285 MB | 952 MB | – | – | –  |
| E Bevy (Rust) | 94.8 MB | 130.8 MB | 130.4 MB | – | 3.20 s | 3.20 s | 427 MB | 903 MB | – | – | –  |

Startup markers: A1 `window.__game` exists (assets loaded, game built); A2 the start screen is shown (BLOOM_SCRIPT click on `#start-best` succeeds); B the log line printed after all loading, before the first frame; E `track ready` (Loading → Menu).
