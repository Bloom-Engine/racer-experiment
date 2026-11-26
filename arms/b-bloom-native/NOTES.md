# Bloom Racer — notes

A small arcade racer (1 circuit, 3 laps, player + 3 AI) written in strict TypeScript on
**Bloom Engine** and compiled to a native app with **Perry**. No Three.js, no web runtime:
Bloom renders (wgpu → Metal), Jolt (via Bloom) simulates, Bloom plays audio and draws the 2D UI.

## Running

```sh
npm install                      # links the local Bloom engine (file:../../bloom/engine)
node tools/gen-track-data.ts     # assets → src/generated/trackData.ts + resources/track_collision.txt
node tools/gen-audio.ts          # procedural engine loops → resources/audio/*.wav
./tools/typecheck.sh             # strict tsc over the game sources
perry compile src/main.ts -o dist/BloomRacer && ./dist/BloomRacer     # dev build, run from repo root
tools/package-macos.sh           # dist/macos/Bloom Racer.app (proper bundle, Finder-launchable)
tools/package-ios.sh install     # build + sign + install + launch on the connected iPhone
tools/build-web.sh --serve       # browser build (WASM + WebGPU) → dist/web, served on http://localhost:8080
```

The generated files are committed, so the two `node tools/…` steps are only needed after the assets change.

Controls: W/↑ throttle, S/↓ brake/reverse, A/D/←/→ steer, Space handbrake (drift), Shift nitro,
R reset, C camera, P/Esc pause, Enter confirm. Gamepad: RT/LT throttle/brake, left stick/D-pad steer,
A/RB nitro, B handbrake, X reset, Y camera, LB pause. Touch: steer left/right, brake, nitro buttons
(multi-touch, auto-accelerate), brake + steer = handbrake drift, pause/camera/reset buttons top-right.

Test/diagnostic flags: `--selftest` (scripted DoD checks, prints PASS/FAIL), `--crashtest` (10 wall impacts
at 300 km/h), `--autopilot` (AI drives the player), `--autostart`, `--bench` (per-lap fps), `--fps`,
`--frames N`, `--shot file.png`, `--savebest`, `--playerskill X`.

## Architecture

```
src/
  main.ts            game-state machine (menu → countdown → racing ⇄ pause → finished) + main loop
  config.ts          all gameplay tuning constants
  track.ts           track visuals (scene nodes), static Jolt collision, racing line, checkpoints, spawns
  vehicle.ts         Car: Jolt rigid body + raycast suspension + arcade tyre/drive model + visuals
  race.ts            rules: ordered checkpoints, laps, positions, slipstream nitro, auto/manual reset, best lap
  ai.ts              AI drivers (racing line + speed profile, avoidance/overtaking, nitro, rubber-band)
  input.ts           keyboard + gamepad + multi-touch → one Controls struct; touch layout
  camera.ts          chase camera (speed FOV, nitro FOV kick, shake) + bumper camera
  audio.ts           RPM-crossfaded engine, shift, screech, nitro, impacts, countdown, fanfare, AI engines (3D)
  hud.ts             HUD, minimap, touch buttons, speed lines, start/pause/finish screens
  sky.ts             textured sky dome (helper: Bloom has no equirect background)
  storage.ts         best-lap persistence (Perry fs + os.homedir; localStorage on web)
  material.ts        scalar scene-node material setter (Perry wasm workaround)
  physfast.ts        allocation-free per-step physics calls (scalar FFI)
  util/math3d.ts     small vector/quaternion/matrix helpers
  generated/         trackData.ts (generated from assets/manifest.json + racing_line.json)
  debug/             selftest.ts, crashtest.ts (verification harnesses, only active via flags)
  types/             ambient types so plain strict tsc can check the game
tools/
  gen-track-data.ts  build-time extractor (manifest numbers, collider triangles)
  gen-audio.ts       procedural engine/shift sounds
  typecheck.sh
  build-web.sh       browser build → dist/web
  embed-glb.ts       embeds a GLB's external textures (web build)
  patch-jolt-bridge.py  fixes Bloom's JoltPhysics.js bridge in the shipped copy
  bloom-web-attach-model.patch  engine fix for glTF node placement on web
resources/           derived data (never written into ./assets, which is read-only)
```

### Frame

1. `pollInput` merges all devices (touch slots scanned sparse-safe via `isTouchActive`).
2. Phase logic (countdown beeps, pause, camera toggle, manual reset).
3. **Fixed 60 Hz simulation** with an own accumulator (max 4 steps/frame): for every car,
   AI/player input → `Car.applyForces` → `physics.stepVariable(world, 1/60)` → `readState` → `race.stepRules`.
   (`physics.step()` does its own sub-stepping without a callback, which doesn't work for force-based vehicles.)
4. Visual interpolation between the last two physics states (smooth on 120 Hz displays), camera, audio.
5. Render: lights + fog per frame, `beginMode3D` (all geometry is retained scene nodes), then the 2D HUD.

### Vehicle model

Not Jolt's `WheeledVehicle`: it gives no control over drift feel, nitro or a hard top speed. Each car is
a Jolt dynamic box chassis (compound + offset centre of mass, CCD on) with:

- 4 suspension raycasts against static geometry only (layer mask), spring-damper tuned by frequency
  (1.7 Hz, ζ 0.5) and scaled by the body's real mass (Bloom has no mass setter).
- Per-wheel lateral tyre force (velocity cancellation clamped to µ·load, applied at CoM height to limit
  body roll); front wheels steer with speed-sensitive lock.
- Longitudinal arcade drive at the CoM: `a = 10.5·(1−(v/vmax)³)` minus rolling/air/off-road drag → ~250 km/h
  flat out; brake 22 m/s²; reverse.
- Drift: handbrake drops rear grip; while sliding, rear grip stays reduced, steering adds yaw torque, and some
  sideways momentum is redirected forward so drifts keep speed. Drifting charges nitro.
- Nitro: +9 m/s² and the cap rises to 300 km/h; FOV kick, speed lines, blue edge tint, camera shake, whoosh.
- Upright assist torque and downforce keep it arcade-stable; cosmetic 6-speed gearbox drives RPM, audio
  and a short power cut on upshifts.

### Rendering

Track and cars are glTF via `loadModel`, with one scene node per primitive (`attachModelToNode`). This
skips the hidden collider primitives, gives each wheel its own transform (spin + steer about the manifest's
pivots) and lets each car swap its paint texture (`setSceneNodeMaterialTextureHandles`). That covers the
colour variants without `KHR_materials_variants`. Brake lights toggle their emissive material. Quality: Medium on
macOS, Low (+ shadows) on iOS, SSAO/motion blur off.

### Rules

- Checkpoints: crossing = the car's segment between two physics steps crosses checkpoint *n*'s plane inside
  its box width/height. Only the *next expected* checkpoint is tested, so skipping or reversing does nothing.
  A lap counts only when `cp_01…cp_15` were crossed in order and then `cp_00`.
- Positions: finish order, then `checkpointsPassed·10⁵ − distanceToNextCheckpoint`.
- Reset: manual (R / button) or automatic after 3 s with no wheel on `col_road`, or upside down for 3 s,
  or falling. The car goes back to the last passed checkpoint on its own lateral slot.

## Libraries chosen and why

| Need | Choice | Why |
|---|---|---|
| Rendering, input, audio, 2D UI | Bloom | required; raylib-style API mapped well onto a game loop |
| Physics | Bloom's Jolt integration (rigid bodies, mesh shapes, raycasts, CCD) | required; custom vehicle on top for arcade control |
| Persistence | Perry stdlib `fs` + `os.homedir` | `perry/system` preferences don't link in a Bloom app; Bloom `writeFile` isn't writable on iOS |
| Type checking | `typescript` (dev only) + `tools/typecheck.sh` | Perry doesn't type-check by default |
| Build tools | Node (type-stripped `.ts`) | no extra dependencies; runs the GLB/WAV tools |

No other runtime libraries and no network access: everything loads from the bundle.

## Verification (macOS, this Mac)

### Definition of Done

| # | Item | Status / evidence |
|---|---|---|
| 1 | Countdown, 3-lap race, correct finish screen | ✅ `--autopilot --autostart`: `RESULT 1.red(153.5) 2.blue(154.1) 3.yellow(156.5) 4.black(157.1)`; finish table lists position, total, best and per-lap times |
| 2 | Player can win and lose | ✅ win: autopilot player at full AI skill → `1.red(153.5) 2.blue(154.1) 3.yellow(156.5) 4.black(157.1)`; lose: `--playerskill 0.9` → `1.blue(163.7) 2.yellow(165.9) 3.black(166.3) 4.red(168.0)` |
| 3 | Nitro fills and fires | ✅ `--selftest`: drift 0.10→0.28, slipstream 0.10→0.21, boost +34 km/h over 2 s vs. no boost; FOV kick + speed lines + edge tint + shake + whoosh |
| 4 | No tunnelling at top speed + nitro | ✅ `--crashtest`: 10 impacts at 300 km/h with nitro held, angles 30–90°, both walls → `tunnelled=0` (CCD + 4 m mesh walls; verified by raycasting launch point → car for the barrier) |
| 5 | Reset (auto + manual) | ✅ `--selftest`: manual R → last checkpoint; upside-down > 3 s → reset upright; off-track > 3 s → reset on road |
| 6 | Checkpoints prevent shortcuts | ✅ `--selftest`: skipping cp_01..07 / out-of-order crossings count nothing; all 16 in order count a lap |
| 7 | Multi-touch | ⚠️ implemented (sparse slot scan, steer + nitro + brake simultaneously, auto-throttle); running on iPhone 16 Pro, but there is no automated multi-touch test — needs a human with two thumbs on the glass |
| 8 | Engine audio follows speed | ✅ 3 RPM layers pitched by rpm/base and crossfaded, shift dip + blow-off. Asset engine loops were near-pure tones (heard as one drone), replaced by procedural loops (`tools/gen-audio.ts`) |
| 9 | HUD incl. minimap | ✅ speed, gear, position, lap, lap time, last, best, nitro bar, rpm bar, minimap with car dots |
| 10 | Best lap persists | ✅ written to `~/Library/Application Support/BloomRacer/best_lap.txt` (iOS: `Documents/`); next launch logged `best lap on record at startup: 49.68…` |
| 11 | Two cameras | ✅ chase + bumper (C / Y / touch button) |
| 12 | ≥ 55 fps on target device | ⚠️ iPhone 16 Pro (the only phone available, faster than the iPhone 12 target): steady **60 fps** (vsync cap) while racing with 4 cars, Low preset. Not measured on an iPhone 12. macOS (M-series, 2560×1440 Retina, Medium): 90 / 85 fps average per lap, worst frame 31–36 ms |

### Build metrics (this Mac, Perry 0.5.1664, Bloom 0.4.19 / 0.5 branch)

| Metric | Value |
|---|---|
| Clean release build of the game (Perry cache deleted, Bloom static lib already built) | **267 s** |
| Bloom native engine from scratch (Rust crate + Jolt, `cargo build --release`, fresh target dir) | **282 s** (so a fully clean build is ≈ 282 + 267 s ≈ 9 min) |
| Incremental rebuild after a one-line change in `src/config.ts` | **5.4 s** (6.4 s for another module) |
| macOS `.app` (`tools/package-macos.sh`) | **71 MB** (executable 23 MB + assets 48 MB + generated data 0.9 MB) |
| iOS `.app` (device, signed) | **76 MB** (executable 27 MB) |

### Source → running iOS build

1. Once per machine: `rustup target add aarch64-apple-ios`, Xcode, `perry setup ios` (App Store Connect API key).
2. Once per bundle id: an *iOS App Development* profile for `com.skelpo.bloomracer` containing the phone.
   `perry setup ios --development` should do this, but it failed on this account (it adds the Apple TV/Watch:
   "Invalid deviceClass"), so the profile was created through the App Store Connect API with iPhone + iPad only and
   saved to `~/.perry/com_skelpo_bloomracer_dev.mobileprovision`.
3. `tools/package-ios.sh install`, which:
   - builds with `PERRY_RUNTIME_DIR=…/target/aarch64-apple-ios/release perry compile src/main.ts --target ios --features ios-game-loop` (without the env var Perry links the macOS stdlib);
   - renames the bundled `resources/` → `gamedata/` (otherwise codesign rejects the bundle);
   - sets `LSApplicationCategoryType = public.app-category.games` and `GCSupportsControllerUserInteraction`;
   - embeds the profile, codesigns with its entitlements, then `xcrun devicectl device install app` + `process launch --console`.
   Extra arguments go to the game, e.g. `tools/package-ios.sh install --autopilot --autostart --bench`.

## Browser build (WebAssembly)

```sh
tools/build-web.sh            # → dist/web/ (4 s; game → WASM via `perry --target wasm`)
tools/build-web.sh --engine   # also rebuild Bloom's bloom_web.wasm (wasm-pack, ~4 min)
tools/build-web.sh --serve    # build + serve on http://localhost:8080
```

Same TypeScript as the native app. The game runs as Perry WASM, rendering is Bloom's wgpu renderer compiled to WASM
(WebGPU, WebGL fallback), physics is JoltPhysics.js (vendored, no CDN), audio is Web Audio. `dist/web` is a static
folder (49 MB: track 30 MB with embedded textures, engine 8 MB) that can go on any static host. It needs no special
headers. Click or press a key once so the browser allows audio.

What the build does on top of Bloom's generic `bloom-web` script:
- ships only the files the game loads, plus `assets_manifest.json` so the engine prefetches everything
  (with a progress line) before the game starts;
- embeds `track.glb`'s external textures into a self-contained copy (`tools/embed-glb.ts`), because web model loading
  only gets bytes;
- patches the shipped copy of Bloom's physics bridge for the JoltPhysics.js API (`tools/patch-jolt-bridge.py`) and
  Perry's handle store (handle reuse), see friction log #26–#27;
- turns URL query flags into game flags: `?autopilot&autostart&bench`, `?selftest`, `?crashtest`, `?fps`, …

Game-side changes for the web (all also run on native; native results unchanged):
- the main loop body is `tick()`: `runGame()` on web (requestAnimationFrame), the blocking loop on native;
- best lap in localStorage on web (Bloom `writeFile`), unchanged files on macOS/iOS;
- workarounds for Perry wasm codegen bugs: explicit `constructor()` in `RaceCamera`, no `this.field.push`, no member
  `++`, no object argument to `setSceneNodeMaterial` (`src/material.ts`), no multi-argument `push` (`sky.ts`);
- allocation-free per-step physics (`src/physfast.ts`) and pooled HUD temporaries, because Perry's wasm runtime never
  frees objects.

One engine-source fix is required and is applied in `../../bloom/engine`: `bloom_scene_attach_model` on web now keeps
the glTF node placement like native (`tools/bloom-web-attach-model.patch`; the build warns if it's missing).

Verified in Chrome (headless, WebGPU, M-series Mac, 1280×720):

| Check | Web | Native (same code) |
|---|---|---|
| `?selftest` / `--selftest` | 11 pass, 0 fail | 11 pass, 0 fail |
| `?crashtest` / `--crashtest` | 10 impacts, 0 tunnelled | 10 impacts, 0 tunnelled |
| 3-lap autopilot race | `1.red(153.4) 2.blue(154.1) 3.yellow(156.3) 4.black(157.0)` | `1.red(153.5) 2.blue(154.1) 3.yellow(156.5) 4.black(157.1)` |
| Frame rate while racing | 60 fps (vsync), worst frame 21 ms | ~111 fps, worst 38 ms |
| Best lap persists across reload | ✅ (localStorage) | ✅ (file) |

## Known issues

- Not verified on an iPhone 12-class device; 60 fps measured on an iPhone 16 Pro only. The Low preset (0.67 render
  scale, shadows on) is a guess for the A14; if it misses, drop shadows first (`setShadowsEnabled(false)`).
- Multi-touch is implemented per Bloom's documented sparse-slot model but was only exercised manually.
- The asset engine loops (`engine_mid/high.wav`) are near-pure tones; the game uses procedural replacements from
  `resources/audio/`. Collision, nitro, screech, beeps and fanfare come from `./assets/audio`.
- No tyre smoke, skid marks or exhaust flames: Bloom particles need a hand-written instanced WGSL material.
- Car-to-car contact is pure rigid-body physics, so a hard hit can spin an AI car; it recovers (reverse/reset logic).
- The AI does not drift and uses a fixed difficulty, with mild rubber-banding (±6–8 % speed).
- The chassis collider is a box, not the asset's convex hull (no runtime mesh access, see friction log #2).
- `iOS simulator` builds fail (Perry ships no simulator stdlib); device builds only.
- The whole `assets/` folder (incl. previews, `.ogg` duplicates, reports) is bundled because Perry copies it verbatim.
- Perry prints two spurious `ConstDeclarationsRequireInitialization` parse warnings on every build.
- Web: tested in desktop Chrome only (headless, WebGPU). Safari/Firefox and mobile browsers (touch) not tried; audio
  was loaded and started without errors but not listened to.
- Web: Perry's wasm runtime still leaks ~480 small objects/s (~170 MB/hour); fine for sessions of an hour or two.
- Web: the Perry-handle and physics-bridge fixes are build-time patches on generated/vendored files and fail loudly if
  Perry or Bloom change those files; drop them once upstream is fixed.

## What I would do next

1. Measure on a real iPhone 12 (`tools/package-ios.sh install --autopilot --autostart --bench` prints per-lap fps)
   and tune the iOS preset (render scale, shadows, sky dome resolution).
2. Particle material for tyre smoke / nitro flames + skid-mark decals (Bloom `vfx` decals are a good fit).
3. Bundle only the assets the game uses (pre-copy step), which would roughly halve the app size.
4. Steering assists for touch (tilt/analog steering zone, auto-brake-lite), a difficulty setting, AI drifting.
5. Car collider from the asset's convex hull (`collider_body`) via the extractor tool.
6. Upstream the friction items: model introspection / collider extraction in Bloom, Perry iOS packaging fixes.

## Effort (this build session)

Measured from the Claude Code session transcript (`usage` fields of all 186 model requests), not estimated:

| Metric | Value |
|---|---|
| Wall-clock time | **1 h 28 min** (first request 11:34, last 13:02 local, 9 Nov 2026), incl. builds, soak races and two waits for user input |
| Model requests | 186 |
| Output tokens | **183,966** |
| Input tokens, uncached | 396 |
| Input tokens, cache writes | 454,211 |
| Input tokens, cache reads | 61,245,518 |
| Total input processed | **61.7 M** (99 % cache reads: the whole conversation context is re-read on every request) |

A large share of the wall-clock time was machine time, not reasoning: each Perry build took ~5–60 s (one clean
build 267 s, one engine-from-scratch build 282 s), each autopilot 3-lap soak race ~3 min, and `--selftest` /
`--crashtest` runs ~1 min each.
