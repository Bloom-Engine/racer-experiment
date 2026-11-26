# Port log: Apex Rush → native (Perry + Bloom three.js bridge)

The unchanged Three.js game (`src/`) is compiled by **Perry** (built from `main`, 1095f50fc5) and runs on
**@bloomengine/three** + **@bloomengine/web**. There is a macOS app and an iPhone app.
Everything native is in `bloom/`, and the setup follows `~/projects/chess/web3d/bloom`:

| File | Lines | |
|---|---:|---|
| `bloom/main.ts` | 9 | native entry: `config.ts` → `@bloomengine/web` → `shims.ts` → `../src/main.ts` |
| `bloom/config.ts` | 34 | window, staged site, served folder, canvas, font, frame-rate profile |
| `bloom/shims.ts` | 179 | the adapters below |
| `bloom/stage-assets.sh` | 16 | stages `index.html`, `assets/` and `style.css` into `bloom/assets/apexrush/` (bundled into the apps) |
| `bloom/build.sh` | 20 | `perry compile` with `bloom-three aliases` |
| `bloom/build-macos.sh` | 39 | `dist/macos/Apex Rush.app` |
| `bloom/build-ios.sh`, `perry.toml` | 102 + 13 | iPhone build, signing, install, launch |
| `src/` (the game) | **2** | `import.meta.env?.…` (entry 4) |

```sh
sh bloom/build.sh            # bloom/dist/apexrush (runs from the repo)
sh bloom/build-macos.sh      # bloom/dist/macos/Apex Rush.app
sh bloom/build-ios.sh device # build, sign, install and launch on the connected iPhone
```

Levels: 1 = already works · 2 = small shim/adapter · 3 = swap a dependency · 4 = rewrite a module.
No change needed level 3 or 4. `three`, `GLTFLoader`, `three-mesh-bvh`, the physics, the AI and the game structure are all unchanged.

## Entries

### 1. Perry codegen fails on three.js 0.187 and three-mesh-bvh
- **What:** with the installed Perry 0.5.1664, codegen fails before linking:
  `native IR construction failed in @…Float16BufferAttribute__getX$idx_u31…: unknown type '{ double, i64 }'`
  in `three.core.js`, `three.module.js` and `three-mesh-bvh/…/ExtendedTriangle.js` (`REFUSING TO LINK`).
- **Category:** `perry-compiler` · **Level:** 1
- **Fix:** none in the project. Perry built from `main` (1095f50fc5) compiles the whole graph, 138 modules, unchanged. 0 lines.
- **Bridge automatically?** n/a. This is a compiler bug that is already fixed upstream. It needs a Perry release.

### 2. iOS link: `_main` undefined
- **What:** `ld: Undefined symbols … "_main"` when linking with `--features ios-game-loop` against a runtime prebuilt with the commands in the chess README.
- **Category:** `perry-compiler` · **Level:** 2 (toolchain)
- **Fix:** build the iOS runtime with `cargo build … --target aarch64-apple-ios -p perry-runtime -p perry-runtime-static --features perry-runtime/ios-game-loop`. That feature provides the `main()` that hands the main thread to UIKit. 0 project lines.
- **Bridge automatically?** yes, in the tooling. Perry only enables that runtime feature when it builds the runtime itself, never for a prebuilt `PERRY_RUNTIME_DIR`. It should either do so or fail with a clear message.

### 3. Native entry and build scripts
- **What:** a native entry is needed; this is the intended integration.
- **Category:** `other` · **Level:** 2
- **Fix:** `bloom/main.ts` + `config.ts` + `build.sh` as in the bridge README and the chess app, about 60 lines. The iOS and macOS packaging scripts were adapted from chess.
- **Bridge automatically?** partly. A `bloom-three init` that writes the entry, `perry.toml` and the packaging scripts would remove most of this.

### 4. `import.meta.env` is undefined (Vite)
- **What:** `TypeError: Cannot read properties of undefined (reading 'BASE_URL')` while loading assets.
  `perry compile --define 'import.meta.env.BASE_URL="./"'` is rejected: `invalid define key … expected an identifier or dotted identifier`.
- **Category:** `perry-compiler` · **Level:** 2
- **Fix:** `import.meta.env?.BASE_URL ?? './'` in `src/core/assets.ts` and `import.meta.env?.DEV` in `src/main.ts`. 2 lines; the Vite build is unaffected.
- **Bridge automatically?** **yes**. Almost every Three.js game is built with Vite. `bloom-three build` should define `import.meta.env` (`BASE_URL`, `DEV`, `PROD`, `MODE`) the way `vite build` does, which needs Perry's `--define` to accept `import.meta.*` keys.

### 5. The page's stylesheet isn't found, so no menu or HUD shows
- **What:** the 3D scene draws, but the start menu and HUD are missing. `index.html` links `./src/style.css`. Vite serves the project root and `publicDir` (`assets/`) as one site. `@bloomengine/web` serves a single folder (`served: "assets/"`, so that `ui/icons/…`, `manifest.json` and the glTF's `../textures` resolve), and the stylesheet resolves to `assets/src/style.css`, which doesn't exist. Without CSS, the full-size canvas pushes the whole page below the window.
- **Category:** `asset-loading-fetch` · **Level:** 2
- **Fix:** `stage-assets.sh` copies the site, without previews, reports or `.ogg` (like the Vite build), and puts `style.css` where the page URL resolves it. `config.ts` points `root` at the staged folder, so the dev binary and the app bundles read the same tree. 16 lines.
- **Bridge automatically?** **yes**. `served` should accept several roots, or simply follow Vite's root plus `publicDir` lookup.

### 6. `FontFace` / `document.fonts` missing
- **What:** the game loads Russo One with `new FontFace(…)`, catches the `ReferenceError` and falls back to Arial Black.
- **Category:** `dom-html-css-hud` · **Level:** 2
- **Fix:** `configure({ fonts: { "Russo One": "assets/ui/fonts/RussoOne-Regular.ttf" } })`. 1 line.
- **Bridge automatically?** yes. `new FontFace(name, "url(…)")` plus `document.fonts.add()` maps directly onto the existing `fonts` table.

### 7. `CanvasRenderingContext2D.drawImage` missing
- **What:** `TypeError: drawImage is not a function` in the `Game` constructor (minimap). The game doesn't start.
- **Category:** `dom-html-css-hud` · **Level:** 2
- **Fix:** `shims.ts` adds `Canvas2D.prototype.drawImage`. It only records the source crop, which entry 8 uses. 8 lines.
- **Bridge automatically?** yes. `drawImage` is one of the most used 2D canvas calls. The bridge can't decode `<img>` pixels in TypeScript today, because the image stays a file for the GPU.

### 8. The page's 2D `<canvas>` (minimap) isn't drawn and costs 6 ms a frame
- **What:** the bridge paints only the 3D view's canvas. The minimap panel stayed empty, and `Minimap.draw` spent **6.1 ms per frame** (measured) rasterizing pixels nobody sees.
- **Category:** `dom-html-css-hud` · **Level:** 2
- **Fix:** in `shims.ts`, a 2D canvas that is in the page gets a small context that replays the minimap's calls as DOM, which the page engine does draw. The crop from entry 7 becomes a positioned `<img>`, and each `translate`/`fill` dot becomes a round `<div>`. The minimap now shows, and app time per frame dropped from 7.6 to 2.0 ms. About 85 lines. The adapter is specific to how this game draws its minimap: no rotated player arrow, the player is a white-ringed dot.
- **Bridge automatically?** **yes**. Page canvases should be drawn by uploading `canvas.data` as a texture when it changes, with rasterization in Rust instead of TypeScript.

### 9. SVG `<img>` icons don't load
- **What:** the pause, camera and reset buttons and the nitro icon were blank. Bloom's texture loader reads raster images only.
- **Category:** `asset-loading-fetch` · **Level:** 2
- **Fix:** `shims.ts` points `img[src$=.svg]` at the pack's `_128.png` versions. 6 lines.
- **Bridge automatically?** yes. Rasterize SVG (resvg) when loading, or at least warn per file. Today it fails silently.

### 10. Web Audio: `AudioParam` automation never forgets past events, so the game slows down over time
- **What:** fps fell steadily during a race (57 → 35 fps after about 3 minutes; the run didn't finish within its time budget). The "input" phase grew by about 1.3 ms per 1,000 frames while memory grew about 1 MB/s. A profile with `PERRY_KEEP_SYMBOLS=1` pointed at `AudioParam._valueAt`. The game calls `setTargetAtTime` about 20 times a frame (engine layers, AI voices, wind, screech), and the bridge keeps and evaluates every event ever scheduled.
- **Category:** `web-audio` · **Level:** 2
- **Fix:** `shims.ts` wraps `setTargetAtTime` and `setValueAtTime`. An event that starts now or earlier first folds the past into the base value, as browsers do. Per-frame cost is now flat at 0.3 ms. 18 lines.
- **Bridge automatically?** **yes, it's a bug**. Any game that drives audio parameters per frame is affected.

### 11. Web Audio: `start(when, offset)` ignores the offset
- **What:** warning `start() with an offset plays from the beginning`. Looping layers start in phase. Not audible in practice.
- **Category:** `web-audio` · **Level:** 1 (accepted) · 0 lines
- **Bridge automatically?** yes. Bloom voices would need to seek.

### 12. Particles, flames and speed lines aren't drawn
- **What:** `three.js on Bloom: points, lines and sprites aren't drawn yet`. Smoke and sparks (`Points` with `ShaderMaterial`), nitro flames (`Sprite`) and speed lines (`InstancedMesh`) are missing natively. Nitro still fills, boosts, kicks the FOV and plays the whoosh, and the CSS vignette works; only the flames and speed lines are missing. Skid marks (a plain `Mesh`) do draw.
- **Category:** `three-api` · **Level:** not fixed · 0 lines
- **Bridge automatically?** **yes**. `Sprite` and `InstancedMesh` map cleanly onto Bloom (billboards, instancing). `Points` with a custom shader needs a point-sprite path, at least for the common `size`/`color` attributes.

### 13. Sky texture and IBL environment
- **What:** `scene.background` (an equirect texture) becomes a clear color from the fog color, and `PMREMGenerator` returns `null`, with Bloom lighting the scene itself. The sky shows flat grey-blue instead of the sky image. Lighting and materials look close to the browser's.
- **Category:** `three-api` · **Level:** not fixed · 0 lines
- **Bridge automatically?** yes. An equirect background texture should draw as Bloom's sky.

### 14. Frame rate: the page engine dominates the frame
- **What:** first native timings (Mac, Retina window): app 7.6 ms (entry 8), page **8.5–13 ms**. iPhone 16 Pro: **38.4 fps steady**, page 14–17 ms. Two causes, both in `@bloomengine/web`:
  (a) any DOM mutation re-runs the whole page (cascade, boxes, layout, paint list: about 9–11 ms on the iPhone), and the HUD changes every frame (lap timer, speed);
  (b) decoration expands into draw calls: a rounded corner is one rect per device-pixel row, a gradient is 24-px cells, a blurred text shadow is four copies. That makes about 4,200 draws per frame for the HUD on the Mac and about **10,200 on the iPhone** at 3× (the round touch buttons alone are about 2,700).
  Measured on the device, the game itself (physics, AI, BVH raycasts, renderer sync) costs 1–2 ms.
- **Category:** `dom-html-css-hud` · **Level:** 2
- **Fix:** in `config.ts` and `shims.ts`, about 40 lines:
  - all platforms: page invalidations are applied every 2nd frame (`APEX_PAGE_EVERY=2`; the HUD updates at 30 Hz and every frame still draws);
  - phones only: Bloom **Low** preset instead of Medium (no shadows, SSAO or TAA), and a **flat HUD** stylesheet (square panels and touch buttons, solid bars, no shadows): about 100 draws instead of about 10,200.
  `APEX_FULL=1` turns it all off. Also measured: on the iPhone, Low alone gives 43.9 fps, Low + every-2nd-frame 49.4, and stripping all decoration at Medium 47.6. Only the full combination clears 55.
- **Bridge automatically?** **yes, it's the biggest gap**. The page engine needs incremental restyle (text-only changes shouldn't re-run the cascade), and native primitives for rounded rects, gradients and shadows, as one draw each.

### 15. `performance.now()` has millisecond resolution
- **What:** it's `Date.now()`. The game's accumulator loop is robust to it; no visible effect.
- **Category:** `timing-raf` · **Level:** 1 · 0 lines
- **Bridge automatically?** yes. Use a monotonic high-resolution clock.

### 16. Gamepad
- **What:** `navigator.getGamepads()` returns `[]`, so controllers don't work natively. Keyboard and touch do.
- **Category:** `input-dom-events` · **Level:** not fixed · 0 lines
- **Bridge automatically?** yes. Map Bloom's gamepad input to the Gamepad API.

### 17. `<table>` laid out as blocks
- **What:** the results table (`<table class="results">`) renders as stacked blocks. Rows get stray separator lines and the columns line up only roughly. On the iPhone, the screen's height shows just the first 2 of 4 rows. The order, times, gaps and best laps are correct.
- **Category:** `dom-html-css-hud` · **Level:** not fixed · 0 lines
- **Bridge automatically?** yes. Basic table layout (`table`/`tr`/`td` as a grid) is common in game result and settings screens.

## Worked unchanged (level 1, no entry needed)

Real three.js scene graph and math; `GLTFLoader` incl. embedded/relative textures and the
`KHR_materials_variants` paints read via `parser.getDependency`; `TextureLoader`; `three-mesh-bvh`
raycasts against the collision meshes at 120 Hz; fog; directional sun with shadows (desktop);
hemisphere light; PBR materials; skid-mark ring-buffer mesh; `fetch` + `json()`/`arrayBuffer()` for
manifest, racing line and WAVs; `decodeAudioData`, buffer sources, gains, biquad filters, stereo
panner, compressor; `localStorage` (best lap/difficulty/mute persisted to a file); keyboard events
(`key`/`code`), pointer events with capture for the touch buttons, `matchMedia('(pointer: coarse)')`
→ touch UI on iPhone, safe-area `env()` insets; `requestAnimationFrame`; `visualViewport`;
`visibilitychange`; the whole DOM/CSS menu and HUD (flex, grid, transitions, keyframe animations,
`@media`, custom properties, `calc()`).

## Definition of Done on the native targets

| DoD | macOS (`Apex Rush.app`) | iPhone 16 Pro |
|---|---|---|
| 1 race completes, results correct | 3-lap autopilot race to the results screen: order, gaps, best laps, splits, "new lap record" ✓ (table as blocks, entry 17) | full race to "YOU WIN!", results ✓ (2 of 4 rows visible, entry 17) |
| 2 win and lose | autopilot finished **2nd** (lose) | autopilot finished **1st** (win) |
| 3 nitro fills & fires | fills, boost, FOV kick, vignette, whoosh ✓; **flames and speed lines missing** (entry 12) | same |
| 4 no tunnelling / 5 resets / 6 anti-shortcut | same game code (physics, `WallGrid`, `RaceProgress` unchanged; three-mesh-bvh compiled natively); not re-run natively | — |
| 7 multi-touch | n/a | touch UI shows, pointers per finger in the bridge; **not tried with real fingers** |
| 8 engine audio follows speed | `audio` report: 9 voices playing; rate/gain automation per frame ✓ | same |
| 9 HUD | all elements incl. minimap (entry 8) and icons (entry 9) ✓ | flat style (entry 14) ✓ |
| 10 best lap persists | `apexrush.v1.bestLap` written, shown after relaunch ✓ | best lap shown across launches ✓ |
| 11 two cameras | C → hood cam ✓ | button present |
| 12 ≥ 55 fps | **66–73 fps** in every window of a full race (Retina 2560×1440, Medium preset, full HUD look); 54.4 without the restyle coalescing | **59.5–59.8 fps** in every window of a full race (phone profile, entry 14); 38.4 without |

Not measured on an **iPhone 12** (the spec's device). Only an iPhone 16 Pro was available. On the A14, the
same profile will probably fall below 55 fps: the page engine is CPU-bound in TypeScript, and the Low preset still
renders at Bloom's auto-resolution.

## Summary

**Changes per category**

| Category | Changes (entries) |
|---|---:|
| `dom-html-css-hud` | 5 (6, 7, 8, 14, 17), 17 not fixed |
| `perry-compiler` | 3 (1, 2, 4) |
| `asset-loading-fetch` | 2 (5, 9) |
| `web-audio` | 2 (10, 11) |
| `three-api` | 2 (12, 13), not fixed |
| `timing-raf` | 1 (15), none needed |
| `input-dom-events` | 1 (16), not fixed |
| `other` | 1 (3) |
| `physics-engine`, `workers`, `wasm`, `storage`, `game-bug` | 0 |

By level: 3 × level 1 (1, 11, 15), 10 × level 2 (2–10, 14), 0 × level 3, 0 × level 4. Four were left unfixed (12, 13, 16, 17).

**Lines changed:** game source **2**. Native adapters `shims.ts` 179 + `config.ts` 34 + `main.ts` 9 = **222**.
Build and packaging 204 (build 20, staging 16, macOS 39, iOS 102, `perry.toml` 13, `package.json` 10, `.gitignore` 4). Total **428**.
Bridge, engine and Perry sources: 0.

**Top 5 bridge improvements that would have made this port unnecessary**
1. **A page engine that keeps up with a game HUD:** incremental restyle and relayout (a text change shouldn't re-run the cascade for the whole page), and rounded rects, gradients and shadows as single native draws instead of thousands of per-row rects. This alone took the iPhone from 38 to 60 fps, at the cost of a flat HUD and the Low preset.
2. **Vite compatibility in `bloom-three build`:** define `import.meta.env`, and serve the project root plus `publicDir` as one site, the way Vite does. Every Vite-built Three.js game hits both on the first launch.
3. **Draw the remaining common three.js objects:** `Sprite`, `InstancedMesh`, `Points` (at least size/color point sprites), and equirect `scene.background`. Effects are where these games differ from a demo scene.
4. **Fix `AudioParam` automation history:** prune past events. Any per-frame `setTargetAtTime` engine sound currently slows the game down without bound.
5. **Complete the 2D canvas and image story:** draw page `<canvas>` elements, add `drawImage`, rasterize natively instead of in TypeScript, load SVG images, and support `FontFace`. (Table layout, entry 17, comes next.)

## Effort: tokens and time

Model: Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code, a single session with no subagents.
Source: this session's transcript (`~/.claude/projects/-Users-<user>-projects-racer-race-A2-run1/53e482dd-e7df-48d5-b56c-960ca3fe1b84.jsonl`).
Its `usage` fields are summed once per API response, from the first prompt to the end of the port, which includes this log.
This effort section itself isn't counted.

| Metric | Tokens |
|---|---:|
| API calls (model turns) | 165 |
| Output tokens (code, prose, tool calls, reasoning) | **111,682** |
| Input: uncached | 362 |
| Input: written to the prompt cache | 339,988 |
| Input: read from the prompt cache | 35,909,772 |
| **Input: total processed** | **36,250,122** |
| Context size at the last call | 367,009 |

Input is large because every call re-sends the whole conversation, including about 25 screenshots and the source of the bridge, Perry and the game that was read.
About 99 % of it came from the prompt cache. For authoritative billing, see `/cost` in Claude Code.

| Time (2026-11-09, CET) | |
|---|---|
| First prompt → port finished | 06:55:43 → 09:52:45 = **2 h 57 min** wall clock |
| Waiting on the user (interrupted, then "continue") | 09:14:32 → 09:33:18 = 19 min |
| **Working time** | **≈ 2 h 38 min** |

Of the working time, a large part was spent waiting on builds and runs rather than on the port:
- building Perry `main`: compiler and runtime ≈ 10 min; iOS runtime, stdlib and UI ≈ 10 min, plus ≈ 6 min to rebuild the runtime with `ios-game-loop`;
- native builds: ≈ 2 min the first time, then ≈ 16 s incremental on the Mac; each iOS build plus install ≈ 2–3 min;
- scripted races: a full 3-lap race takes ≈ 2.5–4 min of real time, run about 6 times across Mac and iPhone;
- about 25 shorter profiling runs on the iPhone (≈ 1 min each).

For comparison, the original browser game (A1, `TOKEN_USAGE.md`) used 62 calls and 175,484 output tokens.
