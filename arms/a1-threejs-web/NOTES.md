# Apex Rush: arcade racer (Three.js + TypeScript)

A 3-lap, 4-car arcade race on the circuit from `./assets`. It runs in desktop and mobile browsers from static files.

```sh
npm install
npm run dev        # dev server (http://localhost:5173, also on the LAN for phone testing)
npm run build      # typecheck (strict) + production build into dist/
npm run preview    # serve dist/ (any static file server works, base path is relative)
```

Controls: **W/A/S/D or arrows** drive, **Space** handbrake/drift, **Shift** nitro, **R** reset,
**C** camera, **P/Esc** pause, **M** mute. On a gamepad: RT/LT throttle/brake, left stick steers, A/RB nitro,
B/X handbrake, Y camera, Back reset, Start pause.
**Touch** (phones): throttle is automatic. Use the left/right buttons to steer and the brake button to brake.
Pressing brake *while steering at speed* starts a drift. The nitro button boosts.
All buttons track pointers independently, so you can hold several at once and slide a finger between the two steering buttons.

## Libraries & tooling: what and why

| Choice | Why |
|---|---|
| **Vite 8** | Instant dev server and a small, fast production build. `publicDir: 'assets'` serves the asset pack verbatim as the web root, so the `.glb` files' relative `../textures/*.png` URIs resolve exactly as authored. `base: './'` lets `dist/` run from any folder. A small build plugin removes files the game never loads (previews, reports, `.ogg` duplicates) from `dist/` only. `./assets` itself is never modified. |
| **TypeScript 7, `strict`** (+ `noUnused*`, `noImplicitOverride`) | As required. `npm run build` fails on type errors. |
| **three.js 0.187** | Renderer, glTF loading (`GLTFLoader`), PMREM environment lighting. |
| **three-mesh-bvh** | BVH raycasts against the hidden `col_road` / `col_terrain` meshes give ground height, normal and surface type. This is cheap enough for 4 cars × 120 Hz. |
| **No physics engine (custom arcade model)** | Rapier/cannon rigid-body vehicles are hard to make *fun and forgiving*, and they cost WASM size and CPU on phones. The handling here (grip, drift angle, nitro) is tuned directly. Walls are handled analytically, which makes tunnelling impossible by construction (see below). |
| **Web Audio API directly** | It needs sample-exact loops, per-layer `playbackRate`, and crossfades. Howler would add little. WAV is used rather than Ogg because Safari's Vorbis support is unreliable and the manifest recommends WAV for perfect loops. |
| **DOM/CSS HUD + 2D-canvas minimap** | Crisp text at any DPR, cheap updates (writes only on change), and accessible buttons. Font: Russo One from the pack. |
| **Playwright (dev only)** | Drives system Chrome (GPU via ANGLE/Metal) for the automated checks in `scripts/`. |

Nothing is fetched from the network at runtime. All models, textures, audio, icons and the font come from the local asset folder.
Effects (skid marks, smoke, sparks, flames, speed lines, wind/rumble noise) are procedural.

## Architecture

```
src/
  main.ts                 boot: load assets → construct Game → start loop
  core/  assets.ts        loads manifest, glTFs, variant paint materials (KHR_materials_variants via parser), sky, audio, font
         manifest.ts      typed subset of manifest.json
         config.ts        all gameplay tuning (car, nitro, walls, race)
         Quality.ts       fps stats + dynamic resolution (steps pixel ratio down if < 54 fps)
         math.ts
  track/ Track.ts         visual scene setup, ground BVHs, racing line (+ curvature, drivable room per point), checkpoints, spawns, projection onto line
         WallGrid.ts      col_barriers → 2D wall segments in a hash grid; swept segment queries
  physics/ Vehicle.ts     arcade vehicle: longitudinal/lateral model, drift controller, nitro, gearbox/RPM, ground following, wall collision
           CarCollisions.ts  car-vs-car (3 circles per car, two-body impulse with yaw)
  ai/    AIDriver.ts      racing-line follower producing the same Controls as a human
  input/ Input.ts         keyboard + multi-touch + gamepad → Controls + edge actions
  audio/ AudioManager.ts  engine layers, screech, wind, nitro rumble, AI engine voices, one-shots
  camera/ CameraRig.ts    chase cam (smoothing, speed FOV, nitro kick, shake) + hood cam + menu orbit
  game/  Game.ts          state machine (menu → countdown → racing → finished, pause), fixed-step loop, ranking, resets, events, FX/HUD/audio glue
         Car.ts, CarVisual.ts, RaceProgress.ts, storage.ts
  fx/    SkidMarks.ts (ring-buffer mesh), Particles.ts (CPU point sprites), SpeedLines.ts (instanced camera-space streaks)
  ui/    Hud.ts, Minimap.ts, Screens.ts
```

**Loop.** Physics runs at a fixed **120 Hz** with an accumulator (max 14 steps per frame). Rendering interpolates car poses between steps.
AI and input are sampled once per frame.

**Vehicle model.** Velocity is split into forward and lateral components relative to the heading.
- *Grip mode:* the yaw rate follows a kinematic bicycle model, capped by a lateral-acceleration limit of about 1.7 g, which gives natural understeer at speed. Lateral velocity decays quickly, limited by a maximum tyre force, so big impacts make the car slide.
- *Drift mode:* entered with handbrake + steer above ~40 km/h. **Steering picks a target drift angle** (≈ 11° to 40°), and yaw follows the velocity's own turn rate plus a correction towards that angle. This is self-stabilising, so the car doesn't spin out. Releasing the steering straightens the car, and grip blends back over 0.45 s. Part of the scrubbed lateral speed feeds back into forward speed, so drifting doesn't kill pace.
- *Other:* slope gravity, off-road drag and grip from the surface under the car, a 6-speed box with torque cut and RPM drop on upshift, and body roll/pitch are visual only.

**Walls / no tunnelling.** The barriers are vertical, so every near-vertical triangle of `col_barriers` becomes a 2D segment.
Each car is three circles (r = 1 m). Every physics step does two things:
1. **Swept test:** the path of each circle centre is intersected with nearby segments, and the car is rewound to just before any crossing.
2. **Penetration resolution:** circle vs segment, with an impulse response that has restitution, Coulomb friction and a yaw kick.

At 300 km/h a car moves 0.7 m per step, which is less than the circle radius, and the swept test covers even that.
Car-car pushes are swept against walls too.

**Checkpoints.** The gate plane of each `cp_XX` trigger box is used. A checkpoint counts only when it is the *next* one in order and is crossed in the race direction inside the box width.
A lap counts when `cp_01…cp_15` have been passed and `cp_00` is crossed. The first crossing of `cp_00` after the start only arms lap 1.
Live positions come from `checkpoints passed × 1e4 − distance to the next checkpoint along the racing line`.

**AI.** AI cars use pure-pursuit steering towards a point ahead on a lane-offset copy of the racing line.
- *Lane choice:* the offset is clamped to the measured asphalt room. Each driver has a personality lane plus a slow wander.
- *Speed:* the target is braking-aware (`min √(v_line² + 2·a·d)` over the next 200 m), scaled by skill × difficulty × a mild rubber band (−7 % … +4.5 %). It is also adjusted for running on the inside or outside of a corner.
- *Traffic:* AI cars pick the roomier side to pass and lift instead of rear-ending (aggressive drivers cut it finer).
- *Nitro:* used on straights.
- *Recovery:* an unstuck manoeuvre (reverse) when stalled, and auto-reset like the player.

AI cars use the same physics and collide physically (no ghosts). The only exception is a 1.6 s blinking ghost window for any car right after a reset, so it can't respawn inside another car.

**Resets.** A car is reset to the last passed checkpoint (or its grid slot) in the first free asphalt slot across the track, with a rolling restart.
- *Automatic:* after more than 3 s off asphalt (run-off/gravel), more than 3 s upside down, or (AI only) 6 s stuck. The HUD counts down "OFF TRACK · RESET IN n".
- *Manual:* R key or the HUD button.

**Rendering.** The track draws as is (18 static draw calls). Colliders are removed from the scene graph.
- *Lighting:* sun and fog from the manifest, the low-res sky as PMREM environment (IBL), ACES tone mapping.
- *Shadows:* a single shadow-casting sun with a 76 m texel-snapped frustum that follows the player. Only car bodies cast shadows (the scenery is static).
- *Load:* ≈ 80–120 draw calls in a race. Shaders are precompiled at start.

**Persistence.** Best lap, difficulty and mute are stored in `localStorage` (`apexrush.v1.*`). Every access is guarded.

## Verification done (Definition of Done)

Automated scripts in `scripts/` (run with a dev server on :5173, or the preview on :4173 for `final.mjs` / `mobileperf.mjs`):

| DoD | How it was verified | Result |
|---|---|---|
| 1 race completes, results correct | `final.mjs` on the production build: real-time lap, then fast-forward to the finish; results table read from the DOM | finish screen, correct order, gaps, live "RACING · LAP 3" row for an unfinished car |
| 2 win **and** lose | `race.mjs <difficulty> <skill>`: the autopilot player at different skills | Normal: skill 1.0 wins by 0.8 s, skill 0.94 finishes 4th. Easy and Hard scale accordingly. |
| 3 nitro fills & fires | `rules.mjs` | drift +0.25 in 1.5 s, slipstream +0.16/s, boost 247 → 279 km/h with FOV kick, flames, speed lines, vignette, whoosh |
| 4 no tunnelling | `walls.mjs`: **50** impacts at 300 km/h + nitro, angles 15–90°, both sides, all sections | 0 crossings (frame-to-frame path test) |
| 5 reset auto + manual | `rules.mjs` (off-track: no reset at 2.5 s, reset by 3.5 s, back on asphalt at the last checkpoint). Manual: R/button run the same path. | ✓ |
| 6 anti-shortcut | `rules.mjs`: line re-crossed without checkpoints, skipped checkpoints, reverse crossing | none count; the full ordered lap counts |
| 7 multi-touch | `mobile.mjs`: CDP multi-point touch events (steer+nitro together, lift one finger, brake+steer drift) | ✓ |
| 8 engine audio follows speed | `final.mjs` samples Web Audio params: layer `playbackRate` = rpm/base, equal-power crossfade, rpm drops on upshift | ✓ (parameters checked, not listened to) |
| 9 HUD | screenshots: speed, gear, rpm bar, position, lap, lap time, best, nitro bar, minimap with dots, warnings | ✓ |
| 10 best lap persists | `final.mjs` reloads the page; the start screen shows the stored lap | ✓ |
| 11 two cameras | C / button toggles chase ↔ hood | ✓ |
| 12 ≥ 55 fps | desktop Chrome, production build, full real-time lap: **60.0 avg**, worst 2 s window 60. Phone proxy (`mobileperf.mjs`, 844×390 @ DPR 3, **4× CPU throttle**): **59.9 avg**, worst window 58. | see the known issues: no physical iPhone was available |

## Known issues / limitations

- **Not measured on a real iPhone 12.** The fps figures come from desktop Chrome, including a CPU-throttled phone-sized run on a Mac GPU.
  Dynamic resolution (start at DPR 1.6 on touch devices, step down to 0.9 when below 54 fps) and 1024² shadows on mobile are the safety nets. The `?fps` overlay shows live numbers on device.
- **Feel has been tuned with scripted traces and screenshots, not human play-testing.** Drift angles, grip and the AI pace are reasonable numerically but deserve a playtest pass.
- **Upside-down auto-reset is effectively unreachable.** The arcade model keeps the chassis aligned with the ground normal, so cars can't flip. The 3 s check exists for completeness.
- **The off-track rule is strict, as specified.** 3 s in a gravel trap resets you even if you are still moving towards the road. Two cars knocked wide together can both get reset.
- **The AI never drifts**; it gains nitro from slipstream and a slow passive trickle. Its rubber band is mild but noticeable if you dominate (leaders lift up to 7 %).
- The gamepad uses the standard mapping but was not tested with physical hardware.
- **Small gaps in the collision meshes:** a few mm-wide gaps between `col_terrain` and the barrier foot are bridged by keeping the last ground height.
- The JS bundle is ~737 kB (195 kB gzip), mostly three.js. It is not code-split.

## What I'd do next

1. Play-test on real phones (iPhone 12, a mid-range Android): tune touch steering curves and maybe add tilt steering, then check thermals over several races.
2. Use KTX2/Basis textures and Draco/meshopt geometry to cut download size (track.glb is 14 MB) and GPU memory.
3. Instance the scenery from `scenery.glb` with LOD/impostors for trees, and frustum-cull per chunk.
4. Add AI drifting in hairpins plus per-driver mistakes; make rubber-banding a difficulty option.
5. Add a ghost car of the best lap, lap splits at checkpoints, a replay camera, and a car-collision camera shake tied to impact direction.
6. Add a proper audio mix: doppler on AI voices, gear-specific engine EQ, and an exhaust pop on lift-off.
7. Run unit tests for `RaceProgress`/`WallGrid` in Vitest, plus run the Playwright scripts in CI.
