# Apex Rush — Bevy arcade racer: notes

A small but complete arcade racer: one 2.2 km circuit, 3 laps, the player against 3 AI cars,
with nitro, drifting, two cameras, keyboard/gamepad/multi-touch input, a HUD with minimap, and
start, pause and finish screens. It targets macOS first and also builds for iOS.

## Versions (pinned)

| | version | notes |
|---|---|---|
| Rust | 1.97.1 stable (edition 2024) | `cargo clippy --all-targets -- -D warnings` is clean, `unsafe_code = "forbid"` |
| **Bevy** | **=0.20.1** | latest stable at the time of writing (released 2026-10-28) |
| avian3d | =0.8.0 | the avian release that targets Bevy 0.20 |
| serde / serde_json | 1.x | manifest, racing line, save file |

## Libraries and why

* **bevy 0.20.1** (default features + `wav`). Default features give PBR, glTF, UI, audio,
  gilrs gamepads, picking and winit. `wav` is added because the engine loops are mathematically
  periodic WAVs (the README warns that the OGGs have encoder padding that breaks seamless loops).
* **avian3d 0.8** for physics. It's ECS-native (components such as `Position`,
  `LinearVelocity`, `Collider` and `RigidBody`, and systems in Bevy schedules), has spatial queries
  (`SpatialQuery::cast_ray`) for raycast suspension, swept CCD (`SweptCcd`) for tunnelling,
  trimesh colliders from Bevy `Mesh`es (`Collider::trimesh_from_mesh`), and built-in transform
  interpolation. Compared with bevy_rapier3d 0.37 (also on Bevy 0.20), avian's data lives in plain
  components, so the vehicle code reads and writes velocities directly without a context resource.
  Default features I don't need (debug renderer, picking, scene) are disabled.
* **Bevy's built-in audio (`bevy_audio`)** instead of `bevy_kira_audio`. What I need is
  per-sink `set_speed` (pitch) and `set_volume`, looping and one-shots, and `AudioSink` already
  provides all of that. It's one less dependency to keep in lockstep with Bevy and keeps the iOS
  binary smaller.
* **Bevy UI** (not `bevy_egui`) for the HUD and menus. A game HUD needs images (minimap, icons),
  a custom font and absolute positioning, which Bevy UI does natively. Menu buttons use Bevy 0.20's
  headless `ui_widgets::Button` with `Activate` events, which handle mouse and touch through
  `bevy_picking`.
* **serde_json** parses `manifest.json` and `racing_line.json`, which are embedded with
  `include_str!` (see below), and reads and writes the best-lap save file.

No other crates. Everything loads from local files; there is no runtime network access.

## Architecture

One plugin per area (`src/lib.rs` wires them):

| module | plugin | responsibility |
|---|---|---|
| `track_data.rs` | (resource) | `TrackData`: spawns, checkpoint boxes, racing line (+ cumulative distance, tangents), minimap transform, sun, fog, car variants, parsed from the manifest |
| `game_state.rs` | `GameStatePlugin` | `AppState` (Loading → Menu → Countdown → Racing → Finished), pause (pauses `Time<Virtual>`, which also stops physics, AI and the race clock), restart / menu messages, `DebugOpts` env switches |
| `physics.rs` | `GamePhysicsPlugin` | avian setup (60 Hz fixed step, 4 substeps), collision layers (Road / Offroad / Barrier / Car), `Surface` tags, fixed-step system ordering, the **tunnel guard** |
| `track.rs` | `TrackPlugin` | spawns `track.glb`, builds static trimesh colliders from the hidden `col_*` nodes, sun with cascaded shadows, ambient light, equirect sky dome, the loading → menu transition |
| `vehicle.rs` | `VehiclePlugin` | car spawning, per-car paint and brake-light materials, **vehicle model**, gearbox/RPM, impacts, auto-reset triggers, wheel / brake light / nitro flame visuals |
| `input.rs` | `InputPlugin` | keyboard, gamepad, **multi-touch** → the player's `VehicleInput`; camera, reset and pause actions |
| `ai.rs` | `AiPlugin` | AI drivers: pure-pursuit steering on the racing line, braking-distance speed planner, lane limits, overtaking and queueing, nitro on straights, stuck recovery, mild rubber-banding |
| `race.rs` | `RacePlugin` | countdown, ordered checkpoints, laps, timing, ranking, finish, reset to the last checkpoint, best-lap persistence |
| `camera.rs` | `CameraPlugin` | chase camera (smoothed, lagging yaw, speed-dependent FOV, nitro FOV kick, shake) and bumper camera |
| `hud.rs` | `HudPlugin` | position, lap, lap time, best lap, speed, gear, nitro bar, minimap with car dots, countdown and banners, speed lines, touch buttons, FPS |
| `menu.rs` | `MenuPlugin` | start screen, pause overlay, results screen (live while the AI finishes), restart |
| `audio.rs` | `GameAudioPlugin` | 3-layer engine crossfade, opponent engine, tyre screech, one-shots |
| `effects.rs` | `EffectsPlugin` | pooled skid marks, impact sparks |
| `persist.rs` | — | `save.json` (best lap) in the platform's app-data dir |
| `testing.rs` | `TestingPlugin` | env-var-driven in-game tests and measurements (see "Verification") |

### Fixed-step pipeline (`FixedUpdate`, 60 Hz)

`Guard` (tunnel guard) → `Input` (AI writes `VehicleInput`; lane limits are computed once) →
`Vehicle` (impact detection, then suspension, drive and grip) → `Race` (countdown, clock,
checkpoints, ranking, resets) → avian's physics step in `FixedPostUpdate`. Rendering uses avian's
`TransformInterpolation`, so 120 Hz displays stay smooth. Player input is sampled in `Update`.

### Vehicle model (arcade)

* A dynamic rigid body (1420 kg, lowered CoM) with a box collider on a child entity.
* **Suspension:** four raycasts (road and run-off layers only), spring and damper forces applied at
  the wheel points, plus a bump stop. This is real physics, so the car follows the hill and the
  dip, pitches and rolls.
* **Drive, brake, grip and yaw** are applied as velocity changes towards targets: an acceleration
  curve up to 253 km/h (250 shown on the straight), braking/reverse, coasting, an exponential
  lateral grip, and yaw rate driven to `steer × max_yaw(speed)`. This is forgiving and stable at
  300 km/h.
* **Drift:** the handbrake above 43 km/h with steering enters a drift. Grip drops, yaw authority
  rises, and the slip angle is held at ≤ ~35° (yaw that would deepen the slide past that is
  cancelled). 80 % of the scrubbed sideways speed is returned as forward speed, so drifts keep
  momentum.
* **Nitro:** the bar fills while drifting (0.20/s, scaled by speed) and in the slipstream of a car
  4–22 m ahead (0.12/s). It fires with ≥ 15 % charge and drains in 3.3 s. It gives a +2.5 m/s
  kick, +11 m/s² acceleration and a 300 km/h cap. Feedback: FOV kick, camera rumble, radial speed
  lines, blue exhaust flames, a whoosh sound and a pulsing bar.
* **Off-road:** a run-off contact (`Surface::Offroad`) caps speed at 55 % and adds drag.

### Camera

The chase camera is rigidly attached to a *smoothed heading* (the yaw lags the car, so drifts show
the car's angle), with smoothed height. An earlier version smoothed the position too, which lagged in
proportion to speed: the car shrank to a dot ~20 m ahead at 300 km/h (caught in simulator
screenshots). The FOV goes from 62° up to ~71° at top speed, plus ~7° while nitro burns. Nitro also
pulls the camera back 1.2 m. Shake = high-speed rumble + impact trauma (decaying). The bumper
camera sits at (0, 0.95, −1.9) in car space. On iOS the HUD and touch buttons are inset 56 pt
horizontally for the notch / Dynamic Island in landscape.

### Wall tunnelling (DoD 4)

Three layers of protection:

1. `SweptCcd` on every car.
2. The barrier colliders are the asset's closed 4 m solids.
3. The **tunnel guard** casts a ray from each car's previous to its current centre against the
   barrier layer every step, and pushes the car back if its centre crossed a wall face.

Upward velocity is also clamped (no legitimate jumps on this track), so wall hits can't launch a
car over the barrier. A **containment check** resets a car that has no track surface below it for
0.5 s.

### Checkpoints (DoD 6)

Each car tests only its **next** checkpoint. A crossing counts when the segment between two
physics steps crosses the checkpoint plane in the race direction (local −Z) inside the box's width
and height. The first `cp_00` crossing (from the grid) arms the lap; crossing `cp_00` after
`cp_01..cp_15` in order completes it. Crossing any other checkpoint out of order is ignored, so
shortcuts never count. Reset places the car at its last crossed checkpoint, choosing a lateral
slot that is free of other cars.

### Data loading

`manifest.json` (216 kB) and `racing_line.json` (≈20 kB) are embedded with `include_str!`. That
makes gameplay data synchronous and identical on every platform, with no bundle-path handling and
no async JSON loader. All models, textures, audio and the font stream through the `AssetServer`
from `./assets`, which is read-only and unmodified. At runtime nothing is generated except
procedural effects (skid marks, sparks, flames, speed lines, the sky dome mesh).

## Verification (what was run, and the results)

All tests drive the real game (physics, rules, rendering) via env vars (`src/testing.rs`). The
commands are listed below; results are from this Mac (M1 Max) unless noted.

| DoD | how | result |
|---|---|---|
| 1 race completes, finish screen correct | `RACER_AUTOSTART=1 RACER_AUTOPILOT=1 RACER_QUIT_AFTER_FINISH=1` | 3 laps completed by all cars; the results screen lists places, total times, best laps and the player's lap times (screenshot checked) |
| 2 win **and** lose | same, `RACER_PLAYER_SKILL=1.32` / `1.05` | 1.32: **1st** (2:06.4 vs BLUE 2:09.1). 1.05: **4th** (2:24.9 vs BLUE 2:16.3). The default autopilot (1.18) finishes 2nd, 1.7 s behind BLUE |
| 3 nitro | `RACER_TEST=nitro` | drift: 0 → 0.21 charge in 1.5 s; slipstream: +0.15 in 2 s; burst: 200 → **301 km/h** in 3.8 s (240 km/h without nitro) |
| 4 no tunnelling | `RACER_TEST=tunnel`: 10 impacts at **300 km/h with nitro held**, angles 20°–90° at 10 different places | **10/10 contained**, max Δv 97 m/s, tunnel-guard interventions: 0 (SweptCcd alone held) |
| 5 reset | `RACER_TEST=reset` | manual (R): placed 0.1 m from the last checkpoint, on the road; off-track: auto reset after **3.02 s**; upside down: auto reset after **3.02 s** |
| 6 shortcuts | `RACER_TEST=shortcut`: teleport from cp_01 to before cp_14, then drive across cp_14, cp_15, cp_00 | lap **not** counted (laps_done 0, still waiting for cp_02); the next genuine lap counts |
| 7 multi-touch | `RACER_TEST=touch` injects OS-level `TouchInput` messages (what winit emits on iOS) into Bevy's touch pipeline; every active `Touch` is hit-tested independently (`input::touch_layout`). Overlay screenshot-checked with `RACER_TOUCH=1` | steer-left + nitro: steer 1.00, nitro on, auto-throttle 1 ✔; + brake as a 3rd finger: brake 1, throttle 0, steer and nitro kept ✔; lift steer-left + new steer-right finger while nitro is held: steer −1.00, nitro on ✔. Not tried with real fingers on a phone (see Known issues) |
| 8 engine audio | 3 layers pitched by `rpm/base_rpm`, crossfaded (unit-tested weights), RPM from a 6-speed gearbox, so upshifts drop the pitch | not listened to on a device in this session |
| 9 HUD | screenshots: position, lap, lap time, best lap, speed, gear, nitro bar, minimap with 4 dots | ✔ |
| 10 best lap persists | `save.json` written on a new best; on the next launch the HUD and start screen show it (seen across runs) | ✔ |
| 11 two cameras | C / camera button / gamepad Y toggles chase ↔ bumper (`RACER_CAMERA=bumper` starts in bumper) | ✔ both screenshot-checked |
| — nitro visuals | `RACER_TEST=nitro` in the iOS simulator, `simctl io screenshot` every 0.8 s | ✔ FOV kick + pull-back, blue exhaust flames, radial speed lines, pulsing/draining bar; 215 → 284 → 300 km/h on the HUD |
| 12 ≥ 55 fps on an iPhone 12-class device | full 3-lap autopilot race in the iOS simulator (release, mobile render settings) | 59.2 fps average in the **simulator** (Mac GPU). **Not measured on an iPhone 12: no device was attached.** See Performance |
| — pause / restart / menu flow | `RACER_TEST=flow` | pause: race clock and car frozen for 2 s ✔; resume ✔; restart → countdown with clock 0 ✔; menu ✔ |

Test commands (from the repo root; `cargo run` sets the asset root itself):
```sh
RACER_AUTOSTART=1 RACER_AUTOPILOT=1 RACER_QUIT_AFTER_FINISH=1 cargo run --release   # full race, RESULT/PERF lines
RACER_PLAYER_SKILL=1.32 ... / RACER_PLAYER_SKILL=1.05 ...                           # win / lose
RACER_TEST=tunnel|reset|shortcut|nitro|touch|flow cargo run                         # (reset/shortcut/nitro/flow also want RACER_AUTOPILOT=1)
RACER_TRACE=1 (per-car status each second), RACER_SCREENSHOT=dir, RACER_FPS=1, RACER_TOUCH=1, RACER_CAMERA=bumper,
RACER_SAVE_DIR=dir (keep tests away from the real best lap)
```

Unit tests (`cargo test`): manifest parsing, checkpoint crossing direction and bounds, spawn
orientation, gears and RPM drop on upshift, engine crossfade weights, save-file round trip, time
formatting.

## Performance

* **iOS simulator** (release, mobile settings, iPhone 17 Pro simulator on the M1 Max, full 3-lap race with 4 cars):
  **59.2 fps average** (laps 59.4 / 58.7 / 59.6) against the 60 Hz vsync cap, via `SIMCTL_CHILD_RACER_*` env vars and
  `log show --predicate 'process == "racer"'`. The simulator uses the Mac's GPU, so this checks the iOS code path but
  is **not** iPhone 12 evidence.
* **macOS** (dev profile, 2560×1440 Retina window, display awake): 67–69 fps on the HUD counter while racing. A full
  release race measured later in the session reported 43.5 fps, but its screenshots were all black: the display was
  asleep or locked, so macOS was throttling an occluded window and the number isn't valid.
* Budgets per frame: the static track has 18 draw calls; each car is about 15 primitives. Lighting
  is one directional light with shadows (1 cascade / 60 m on iOS, 2 cascades / 140 m on desktop).
  The sky is one unlit mesh. There are no post effects beyond tonemapping and MSAA (no bloom, SSAO
  or SSR).
* CPU: 4 cars × 4 raycasts per tick, AI racing-line tracking is windowed (±24 points), and physics
  runs at 60 Hz with 4 substeps.
* iPhone 12 class: not measured in this session. This configuration should fit, but it needs a
  device run. If it falls short, first drop MSAA to 2x and shadows to 1024².

## Build metrics (this Mac: Apple M1 Max, 10 cores, 64 GB, macOS 26.5, Xcode 26.6, Rust 1.97.1)

| metric | value | notes |
|---|---|---|
| clean release build (`cargo build --release`, empty target dir) | **11 min 27 s** | 2511 s CPU; thin LTO, `codegen-units = 16`. Nothing else was compiling |
| incremental rebuild, one-line change in `src/hud.rs`, **dev** profile | **9.6 – 12.0 s** | the iteration profile: our crate at `opt-level 1`, deps at 3 |
| incremental rebuild, same change, **release** | **5 min 46 s** | dominated by thin-LTO re-optimisation of the whole program; use dev for iteration |
| first (cold) debug build | 16 min 40 s | while an unrelated Rust build was competing for CPU |
| iOS simulator build (`scripts/build_ios.sh`, release, cold target) | 10 min 24 s | |
| iOS device build (`scripts/build_ios.sh --device`, release, cold target) | 11 min 33 s | |
| **macOS `.app`** (`scripts/build_macos_app.sh`) | **131 MB** | 95 MB stripped binary + 36 MB assets |
| **iOS `.app`** (device, arm64) | **130 MB** (55 MB zipped, roughly the IPA download size) | 94 MB stripped binary + 36 MB assets |

The binaries are large because they include Bevy's full default feature set (2D *and* 3D renderers, all
of bevy_ui and widgets, gilrs, ...). The first thing to cut is `default-features = false` with an explicit feature list
(drop 2d/sprite, dev tools, ktx2/zstd and so on), then `opt-level = "s"`, `lto = "fat"`, `codegen-units = 1` and
`panic = "abort"` for distribution builds.

### From source to a running iOS build

Prerequisites: Xcode (26.x) with an iOS simulator runtime, and
`rustup target add aarch64-apple-ios aarch64-apple-ios-sim`.

Simulator:
```sh
scripts/build_ios.sh                                   # cargo build --release --target aarch64-apple-ios-sim,
                                                       # assembles target/ios/sim/ApexRush.app (Info.plist from ios/,
                                                       # runtime assets copied), ad-hoc codesign
xcrun simctl boot "iPhone 17 Pro"                      # any iOS simulator
xcrun simctl install booted target/ios/sim/ApexRush.app
xcrun simctl launch booted com.skelpo.apexrush
# logs: xcrun simctl spawn booted log stream --predicate 'process == "racer"'
# test switches: prefix env vars with SIMCTL_CHILD_, e.g. SIMCTL_CHILD_RACER_AUTOPILOT=1
```

Device (iPhone):
```sh
# a development provisioning profile whose App ID matches com.skelpo.apexrush (or change the id in ios/Info.plist)
IOS_SIGN_IDENTITY="Apple Development: <Name> (<ID>)" \
IOS_PROFILE=~/Downloads/ApexRush_Dev.mobileprovision \
scripts/build_ios.sh --device                          # aarch64-apple-ios, embeds the profile, signs with its entitlements
xcrun devicectl list devices
xcrun devicectl device install app --device <UDID> target/ios/device/ApexRush.app
xcrun devicectl device process launch --device <UDID> com.skelpo.apexrush
```
No Xcode project is needed: Bevy's iOS support is a normal Rust binary (winit + Metal via wgpu), and the bundle is a
directory with `racer`, `Info.plist` (with `UILaunchScreen`, so the app runs at native resolution, landscape only)
and `assets/`. Bevy loads assets relative to the executable, which sits at the bundle root on iOS.

## Known issues

* **No on-device iOS run in this session.** No iPhone was connected. The simulator build installs,
  launches and completes a full race at 59 fps, but frame rate on an iPhone 12, physical multi-touch
  (the injected-touch test covers everything except the OS layer) and audio on a device are
  unverified. Audio in general was not listened to (the asset WAVs load without errors).
* Late in the session, macOS window captures went black a few seconds after launch (the display
  slept or locked while unattended; an occluded window also stalls rendering, which once looked like
  a freeze). The macOS FPS figure for the release `.app` is therefore not valid. Visual checks after
  that point were done in the iOS simulator, which renders offscreen.
* Runs are deterministic: same inputs give the same results. The AI varies its line by time-based
  wander rather than randomness, so races replay identically. Seeding the wander would add
  variety.
* The AI never drifts, so it gets a small passive nitro fill (0.025/s) instead. The player-facing
  rules (drift and slipstream) are unchanged.
* The AI rubber-bands mildly (±2.5 % speed per checkpoint gap to the player).
* No KHR_materials_variants or KHR_node_visibility support in Bevy; both are handled manually
  (see the friction log).
* Audio is non-spatial (only the nearest opponent's engine is mixed in, attenuated by distance).

## What I would do next

1. Profile on a real iPhone 12 (Xcode Instruments, Metal frame capture) and tune MSAA and
   shadows per device tier.
2. Tyre smoke particles and a nitro screen-space distortion; a better engine sound with load
   (throttle on/off) layers.
3. A smarter AI: drift through the hairpin, defensive lines, difficulty presets instead of fixed
   skills.
4. A ghost of the best lap, and per-sector split times on the HUD.
5. An Xcode project / `cargo-bundle` setup for signing and App Store packaging, plus app icons.
6. CI that runs the in-game tests headless (Bevy's `bevy_ci_testing` or an offscreen render target)
   so screen sleep can't affect them.

## Development effort

Measured from this session's transcript (`~/.claude/projects/.../407b0dee-….jsonl`) and file timestamps:

| | |
|---|---|
| Wall-clock time | **≈ 3 h 09 min**: 2026-11-09 08:22 → 11:31 CET (first prompt → final notes). This includes one user interruption/"continue" |
| …of which waiting on compiles | ≈ 75 min (cold debug 16:40, first release 13:29, iOS sim 10:24, iOS device 11:33, clean-build metric 11:27, incremental release metric 5:46, macOS `.app` 6:10, two iOS-sim rebuilds ≈ 3:35 each; some of these overlapped other work) |
| Model API calls | 163 (Claude Opus 5.5) |
| Output tokens (code, docs, reasoning, tool calls) | **≈ 214 k** |
| Input tokens, fresh (uncached) | 344 |
| Input tokens, written to the prompt cache | ≈ 385 k |
| Input tokens, read from the prompt cache | ≈ 43.8 M (the growing conversation context, re-read on every call) |
| **Total input processed** | **≈ 44.2 M tokens** |
| Result | ≈ 5,800 lines of Rust in 16 modules, 2 build scripts, Info.plist, NOTES.md, BEVY_FRICTION.md |

Token figures are summed from the per-call `usage` records (deduplicated by message id). They don't include the
final call that wrote this section.
