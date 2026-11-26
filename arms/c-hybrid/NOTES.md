# Arcade Racer: three.js + Bloom hybrid (Perry native)

A 3-lap, 4-car arcade racer. **three.js** owns the scene and how things look; **Bloom** owns
everything around it: Jolt physics and vehicles, input, audio, 2D HUD, persistence, the app shell.
Compiled to a native macOS binary and an iPhone app by Perry. No DOM/HTML/CSS in the game, no Web
Audio, no workers, no WASM.

## Build & run

```sh
npm install                      # @bloomengine/web comes from ../../bloom/web (see HYBRID_FRICTION #2)
sh scripts/build.sh              # macOS  -> dist/racer          (~2.5 min, recompiles three.js each time)
./dist/racer
sh scripts/build-ios.sh          # iPhone -> dist/ios/racer.app  (~6.5 min, dev-signed by Perry)
xcrun devicectl device install app --device <UDID> dist/ios/racer.app
xcrun devicectl device process launch --console --device <UDID> com.skelpo.racer.hybrid
npm run typecheck                # (filter to src/ — the engine package's own .ts doesn't typecheck)
```

Perry 0.5.1663 (`perry-main-latest`) is pinned in `scripts/build.sh`. The `perry` on PATH (0.5.1664)
miscompiles three.js.

**Controls.**
- **Keyboard:** arrows/WASD drive, Space drift (handbrake), Shift nitro, R reset, C camera, P/Esc pause, Enter confirm.
- **Gamepad:** RT/LT throttle and brake, left stick steer, A/RB nitro, X/LB drift, B reset, Y camera, D-pad up pause.
- **Touch:** automatic throttle; on-screen ◀ ▶, BRAKE, NITRO, DRIFT, plus reset/camera/pause icons.
  Each finger is tracked by its own slot, so steering and nitro work at the same time.

## Architecture

```
bloom/main.ts          native entry: configure @bloomengine/web (page:"none"), import the game
src/main.ts            new Game(); init(); renderer.setAnimationLoop(frame)
src/game.ts            state machine (menu → countdown → race → finished, + pause), nitro, resets,
                       impacts; the per-frame order below
src/track.ts           manifest + racing line + checkpoints + minimap transform (pure data/math)
src/race.ts            checkpoint plane crossings in order, laps, positions, lap times (pure logic)
src/ai.ts              AI drivers: pure pursuit on the racing line, braking to the speed profile ahead,
                       avoidance, nitro on straights, mild rubber band, stuck recovery
src/physics/world.ts   Bloom/Jolt world, static track meshes, fixed 60 Hz stepping, probes, wall guard
src/physics/vehicle.ts Bloom/Jolt wheeled vehicle + arcade forces (limiter, drag, downforce, yaw assist,
                       drift model with slip cap, accel push, nitro)
src/sync.ts            ★ THE BOUNDARY: physics poses → three.js Object3Ds, once per frame, interpolated
src/render/scene.ts    three.js: renderer, scene, lights, fog, track + car models, car views (brake
                       lights, nitro flames)
src/render/effects.ts  three.js meshes: speed lines, skid marks, sparks, drift smoke
src/camera.ts          three.js: chase cam (offset smoothing, speed FOV, nitro kick, shake) + bumper cam
src/input.ts           Bloom input: keyboard, gamepad, multi-touch slots → one InputFrame
src/audio.ts           Bloom audio: 3 engine layers crossfaded by rpm, shift dip, screech, 3D opponent
                       engines, one-shots
src/hud.ts             Bloom 2D: HUD, minimap, touch buttons, start/pause/finish screens
src/storage.ts         Bloom writeFile/readFile: best lap in Application Support
src/testing.ts         BLOOM_SCRIPT commands for repeatable checks (autopilot, wallshot, flip, ...)
```

Per frame (`Game.frame`): Bloom input → AI → `PhysicsWorld.advance` (fixed 1/60 s steps; arcade forces
per step) → Jolt contacts (impacts) → race rules (checkpoints, laps, nitro fill, auto-reset) →
**`sync.ts`** → effects + camera (three.js) → `renderer.render` (the bridge mirrors the scene into
Bloom) → HUD (Bloom 2D, same frame) → audio.

Data flows one way across the boundary. Collider triangles go three.js → physics once at load
(`triangles()` reads the hidden `col_*` meshes). Every frame after that, poses go physics → three.js
in `sync.ts`. three.js state is never read back into physics.

## Libraries and why

| | why |
|---|---|
| **three 0.187.0** | the brief; real three.js under the bridge. 0.186.1 hit the same Perry codegen bug |
| **@bloomengine/three 0.1.1** | swaps `WebGLRenderer` for one that mirrors the scene into Bloom |
| **@bloomengine/web** (checkout) | the browser layer the bridge needs (fetch for `file://`, `<img>`, blob URLs). The game uses none of its DOM, CSS or Web Audio |
| **@bloomengine/engine 0.4.19** | Jolt physics + vehicle, input, audio voices, 2D text/shapes/textures, file I/O, procedural sky |

No other dependencies. Everything loads from local files.

## Definition of Done: status

Checked with scripted runs (`BLOOM_SCRIPT`, `RACER_LOG=1`) on macOS unless noted.

1. **Full race works:** start → 3-2-1-GO → 3 laps → finish table (positions, totals, best laps,
   per-lap times) → Restart. ✅ Autopilot race: `YOU P1 179.6 s`, AIs 183.3/184.2/184.8 s.
2. **Win and lose:** ✅ The 0.95-skill autopilot wins (above). At 0.84 it finishes P4 (195.7 s vs AI
   183.0–187.5). The AI is at 0.95/0.925/0.90 of the racing-line speed profile, plus a ±7% rubber band
   beyond 120 m.
3. **Nitro:** ✅ fills while drifting (0.25 → 0.57 in 2 s of drift) and while drafting within 22 m
   behind a car. Firing it: +15 kN thrust, top speed 250 → 300 km/h (182 → 239 km/h in 3 s), FOV
   +12°, speed streaks, exhaust flames, whoosh.
4. **No wall tunnelling:** ✅ `wallshot` fires the car at 300 km/h, 60° into the nearest wall, at 12
   places around the lap. 12/12 ended inside (a probe under the car finds road or run-off), and the
   segment-vs-wall guard never had to intervene (Jolt CCD on the chassis; 4 m walls).
5. **Reset:** ✅ manual (R / button / pad B) and automatic: off the road > 3 s
   (`[reset] YOU (off track) to cp_3`), stuck > 6 s, upside down > 3 s. Respawns at the last passed
   checkpoint, beside other cars if one is there. Note: Jolt's pitch/roll limit (0.9 rad) rights a
   flipped car within a frame, so the upside-down timer is a fallback that rarely fires.
6. **Checkpoints:** ✅ `shortcut 6` from before cp_2 → "MISSED CHECKPOINT — GO BACK"; the next
   expected checkpoint stays cp_4 and the lap can't complete until it is passed.
7. **Touch with multi-touch:** ⚠️ implemented (slot-scanned fingers, each held button independent;
   steer + nitro together). The layout is verified with `RACER_TOUCH=1` on the Mac, and the app runs on
   an iPhone 16 Pro. Real-finger multi-touch hasn't been exercised by a person yet; scripted runs
   can't inject touches.
8. **Engine audio follows speed:** ✅ Jolt engine rpm drives pitch (rpm / base_rpm) and a log-rpm
   crossfade of idle/mid/high; gear changes (automatic gearbox) dip the volume briefly.
9. **HUD:** ✅ speed, gear, position n/4, lap n/3, lap time, best lap, nitro bar, rpm strip, minimap
   with four coloured dots, countdown, messages.
10. **Best lap persists:** ✅ written with Bloom `writeFile` to
    `~/Library/Application Support/arcade-racer-hybrid/save.json` (the iOS container on the phone);
    shown on the start screen after a restart.
11. **Two cameras:** ✅ chase and bumper/hood (C / button / pad Y).
12. **≥ 55 fps on target device:** ⚠️ 60 fps locked on an iPhone 16 Pro over a full race; not measured on an iPhone 12 (see Performance).

## Performance

- **macOS** (M-series, 2560×1600 Retina, Medium preset): game work 1.3 ms/frame (input, AI, physics,
  sync, bridge mirroring), GPU present 8–10 ms. Average 113 fps over a full 3-lap race with 4 cars.
- **iPhone 16 Pro** (on-device, scripted autopilot race, all 3 laps, 4 cars): **60.0 fps locked.**
  2000 frames every 33.3 s across the whole race; 138 one-second samples, average 59.96, minimum
  55.6; worst single frame 31 ms. Game work 2.9 ms/frame, GPU present 12.1 ms.
  Phone settings (`render/scene.ts`): Bloom `QualityPreset.Low`, 0.6 render scale with 60 Hz dynamic
  resolution, no shadow map, far plane 1100 m.
  With the web layer's default Medium preset (shadows, SSAO, TAA), the same phone dropped to 40–43 fps
  after about 45 s (thermal) and averaged 43–58 per lap.
- **iPhone 12 class (the DoD device):** not measured; no A14 phone was available (the paired iPad Air 4,
  also A14, was offline). The 16 Pro spends ~12 ms per frame on GPU present, and dynamic resolution
  should absorb the A14's lower GPU throughput, but treat DoD #12 as **unverified on the target device**.

## Known issues

- The asset sky panorama, normal maps and ORM maps are unused (the bridge doesn't pass them). The
  sky is Bloom's procedural atmosphere.
- The billboard atlas shows as plain grey panels.
- Drift smoke is opaque-ish small puffs (bridge transparency); skid marks are subtle.
- Gear is inferred from rpm (the vehicle API has no getter), so it can flicker briefly under wheelspin.
- Car-to-car contacts use full tyre friction (the chassis friction must stay high for grip), so
  side-by-side rubbing is sticky.
- Every build recompiles three.js (~2.5 min macOS, ~6.5 min iOS).
- The window can be rotated to portrait on iOS (the web layer requests a portrait window); the HUD
  is designed for landscape.

## What I'd do next

- Move the arcade handling into a small custom raycast vehicle (Jolt rigid body + 4 raycasts). The
  Jolt vehicle's fixed mass, gearbox and tyres fight the arcade assists.
- Upstream the shim fixes (#6/#7 in the friction log) and pass normal/ORM/emissive maps in the bridge.
- An `InstancedMesh` → Bloom instancing path, then use `scenery.glb` prototypes instead of the
  101k-triangle baked trees.
- AI personalities (overtaking aggression, defensive lines), and AI drift + nitro use in corners.
- Ghost replay of the best lap; per-track records.
- Haptics (`gamepadRumble` exists for pads; a phone haptic API would be needed).
