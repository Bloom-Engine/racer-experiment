# HYBRID_FRICTION.md — three.js (via the Bloom bridge) + Bloom systems

Format per entry: **expected** / **actual** / **how I found out** / **cost**.
Versions: `@bloomengine/engine` 0.4.19 (npm), `@bloomengine/three` 0.1.1 (npm),
`@bloomengine/web` local checkout (see #2), three 0.187.0, Perry 0.5.1663 (`perry-main-latest`).

## Toolchain

### 1. Perry on PATH can't compile three.js
- **Expected:** `npx bloom-three build` with the `perry` on PATH compiles three.js, as the bridge README says.
- **Actual:** Perry 0.5.1664 (`perry-latest`) fails LLVM codegen in `three.core.js` / `three.module.js`
  (`getelementptr ... unknown type {double, i64}` in `Color.getHSL`, `Color.setHex`,
  `generateEnvMapModeDefine`) for both three 0.186.1 and 0.187.0. Perry 0.5.1663 (`perry-main-latest`
  worktree, built later the same day) compiles it.
- **How:** the first build refused to link. Changing the three version didn't help. Finally I found
  another Perry worktree on the machine.
- **Cost:** ~25 min (three failed 2–4 min builds + investigation). `scripts/build.sh` pins `PERRY`.

### 2. npm `@bloomengine/web@0.2.0` crashes at start on current Perry
- **Expected:** the published web layer runs.
- **Actual:** `TypeError: Cannot set property navigator of #<Object> which has only a getter at pageLoaded`.
  The published file assigns `globalThis.navigator = {...}`. The source checkout already replaced
  that with `Object.defineProperty`, but it isn't released yet.
- **How:** first run of the cube test; diffed `node_modules/@bloomengine/web/src` against `../bloom/web/src`.
- **Cost:** ~10 min. Installed with `npm install --install-links ../../bloom/web` (a packed copy,
  so the checkout's own `node_modules` engine isn't pulled in a second time).

### 3. Every rebuild recompiles three.js (~2.5 min)
- **Expected:** incremental builds after a one-line change to game code.
- **Actual:** each `bloom-three build` takes 2:10–2:40 on an M-series Mac (500 s CPU). Most of that is
  three.js codegen. The iOS build takes 6.5 min.
- **Workaround:** handling constants are read from `RACER_TUNE` (JSON) at launch, so tuning needs no
  rebuild. Scripted runs (`BLOOM_SCRIPT` + my own commands) replace hand testing.
- **Cost:** structural. Roughly 40% of wall time in this project was waiting for builds.

### 4. iOS device build: three separate traps
- `--target ios` fails in the *assembler*: `instruction requires: rcpc` (Perry emits `ldapr` but the
  default cross baseline is `generic`). Fixed with `--march apple-a14` (iPhone 12 = A14). Nothing in the
  iOS docs mentions it. Cost: a 5-min failed build.
- `PERRY_RUNTIME_DIR` must point at `target/aarch64-apple-ios/release` for iOS. With the host dir,
  `ld: building for 'iOS', but linking in object file ... built for 'macOS'`. The bridge CLI
  forwards the env unchanged, so a build script that sets it for macOS breaks iOS. Cost: an 8.5-min failed build.
- `--features ios-game-loop` is documented in Bloom's `docs/ios-target.md` but not in the bridge README,
  which is where a three.js developer looks first.

### 5. `tsc` fails inside the engine package
- **Expected:** `tsc --noEmit` with `skipLibCheck` typechecks the game.
- **Actual:** the engine ships `.ts` sources, so they are checked. `src/index.ts` re-exports ~30 physics
  names that no longer exist (`createPhysicsWorld`, `applyForce`, `RigidBodyHandle`, ...), plus
  duplicate `Vec2/3/4` and an unresolvable `perry/thread`.
- **Workaround:** filter `tsc` output to `src/` and `bloom/`. Our code is clean under `strict`.
- **Cost:** 5 min.

## Physics (Bloom Jolt) — the big ones

### 6. Vehicle wheels never touch ground on `Layer.NON_MOVING`
- **Expected:** static track bodies on `Layer.NON_MOVING`, as the physics docs' quick-start does,
  plus `createVehicle` gives a car standing on its wheels.
- **Actual:** the car sat on its hull at 6000 rpm and 0 km/h. The shim builds
  `VehicleCollisionTesterRay(BJ_LAYER_NON_MOVING, ...)`, and its own `ObjectVsBPFilter` lets
  a NON_MOVING object test only the MOVING broadphase. So wheel rays can **never** hit layer-0
  statics, only other dynamic bodies.
- **How:** read `bloom_jolt.cpp` (`bj_vehicle_create`, the filter classes).
- **Workaround:** the track goes on custom object layer 3. Every non-zero layer lands in the MOVING
  broadphase, so wheel rays, the chassis and my probes (`1 << 3` mask) all see it.
- **Cost:** ~20 min plus one rebuild. The `vehicle_api_smoke` test "intentionally does not assert
  drive-forward", which is exactly why this went unnoticed.

### 7. `VehicleConfig.forward` doesn't set the drive direction
- **Expected:** `forward: {0,0,-1}` (glTF cars face −Z) makes throttle drive towards −Z.
- **Actual:** throttle drove the car backwards. The shim never sets `WheelSettings.mWheelForward`
  (Jolt default +Z). `forward` only feeds the constraint's pitch/roll reference.
- **Workaround:** the physics body is the model frame turned 180° about Y (hull points, wheel mounts
  and COM mirrored). `vehicle.ts` converts rotations at its boundary (`flipY`), so nothing else knows.
- **Cost:** ~15 min plus a rebuild.

### 8. Chassis friction is also the tyres' grip
- **Expected:** `setFriction(chassis, 0.15)` makes body-on-wall contact slide.
- **Actual:** Jolt combines wheel friction with the *vehicle body's* friction (`sqrt(0.15·1.0)` ≈ 0.39),
  so the car spun its wheels in 1st gear and topped out near 90 km/h. Not documented in the Bloom
  docs. The docs' advice is "raise the ground friction".
- **Workaround:** chassis friction 1.0, wall friction 0.05.
- **Cost:** 1 rebuild, 10 min.

### 9. The vehicle API is thin for a racing game
No getters for gear, wheel contact, slip or suspension length. Mass is fixed at 1500 kg. Gearbox,
torque curve and tyre curves can't be set. The handbrake locks the rears completely, so they lose all
side grip.
- **Workarounds:** gear inferred from engine rpm ÷ driven-wheel rpm against Jolt's default ratios; one
  down-ray per car for ground and surface; the arcade handling (yaw assist, drift model, slip cap,
  speed limiter, downforce, acceleration push) done as per-step forces. That forced a self-driven
  fixed-step loop (`stepVariable` per 1/60 s) with my own interpolation in `sync.ts`, because forces
  must be applied per solver step, not per frame.
- **Cost:** most of the handling-tuning time.

### 10. Docs vs code drift
- `physics.md` says raycast normals are "currently (0,1,0)". The shim now computes real normals.
- `VehicleConfig.wheelPositions` says "relative to COM". In practice it is relative to the body
  origin (the shape origin, not the offset COM).
- **Cost:** small, but each needed a source read to trust.

### 16. The web layer picks the Medium preset on phones
`@bloomengine/web` opens the window with `QualityPreset.Medium` (shadows, SSAO, TAA) everywhere,
with a 0.6 scale on phones. On an iPhone 16 Pro that thermally throttled to 40–43 fps after ~45 s
of racing. `QualityPreset.Low` + no three.js shadow map held 60.0 fps for the whole race. The
preset belongs to the game, and the default is easy to miss because it is set inside the
browser layer. Cost: one device run plus a 6.5-min iOS rebuild.

## Bridge (three.js → Bloom)

### 11. What the renderer silently drops
- **Not drawn:** `Points`, `Line`, `Sprite`, `InstancedMesh`. Every effect is a `Mesh`: speed streaks
  are thin boxes, skid marks are one ring-buffer geometry, sparks and smoke are pooled meshes.
- Only `material.map` is passed: **no normal maps, no ORM/roughness maps.** The track's PBR set is
  half unused.
- `MeshBasicMaterial` draws as flat emissive `color` with base color 0, so **a textured unlit
  mesh shows no texture.** A sky dome from `sky_equirect_2048x1024.png` is impossible, so the asset sky
  is unused and the sky is Bloom's `setProceduralSky` (a direct Bloom call next to three.js code).
- `scene.background` as a texture → clears to the fog colour.
- `alphaMode: MASK` with alpha 0 (the colliders' `collider_invisible`) renders **opaque**: only
  `transparent` materials get opacity, and `KHR_node_visibility` isn't honoured. The colliders must be
  hidden by hand (`visible = false`). The asset README promised "they never render even if the engine
  ignores the extension".
- `transparent` + per-frame `opacity` on the smoke reads as solid. Tuned down to small light puffs.
- Material `side` is ignored: skid-mark quads are emitted with both windings.

### 12. Frame loop ownership is split
`renderer.setAnimationLoop` drives the frame (from `@bloomengine/web`'s `setTimeout` loop).
`renderer.render()` does `beginMode3D/endMode3D` itself, and Bloom 2D HUD calls only work *after* it
in the same callback. That is undocumented, but it works fine once known.

## Other Bloom APIs

### 13. Gamepad constants don't exist
No `GamepadAxis` / `GamepadButton` exports. The mapping (axes 0–3 sticks with Y inverted, 4/5
triggers; buttons A=0, B=1, X=2, Y=3, LB=4, RB=5, D-pad 12–15; Menu/Start not mapped) came from
`native/macos/src/lib.rs`. Cost: 10 min.

### 14. `mobile.updateVirtualButton` has the slot bug its own core docs warn about
It iterates `0..getTouchCount()`, which `isTouchActive`'s doc comment calls wrong (slots go sparse).
I wrote my own multi-touch layer scanning `0..getMaxTouchPoints()` with `isTouchActive`.

### 15. File and path details
- `writeFile` doesn't create folders (`mkdirSync` from `node:fs` first).
- On macOS, asset paths are CWD-relative (`bloom_resolve_asset_path` is identity), so they break in a
  `.app` launched from Finder. Everything uses absolute paths from `src/paths.ts`.
- The web layer warns "no index.html" on every launch when the game draws its own UI (`page: "none"`).

## Where did mixing Three.js and Bloom feel natural, where awkward?

**Natural:**
- **Scene authoring.** `GLTFLoader`, `clone(true)`, per-car material clones, `Object3D` hierarchies
  (flames parented to exhaust empties, speed lines parented to the camera), `lookAt`, `Euler`
  wheel rotations. All ordinary three.js, and it just appeared in Bloom.
- **Reading collider triangles** from the three.js glTF graph (`matrixWorld`, `BufferAttribute`) and
  handing plain arrays to `P.meshShape`: a clean one-way, load-time handoff.
- **Bloom 2D for the HUD.** `drawTextEx` with the asset TTF, `drawTexturePro` for the minimap. It
  beats rebuilding a HUD from three.js sprites (which wouldn't draw anyway).
- **Bloom audio voices** (`playSoundEx` + `voiceSetPitch/Volume`, `playSound3DEx` for opponents):
  far simpler than a Web Audio graph for RPM-crossfaded engine layers.
- **`sync.ts` as the only crossing point** each frame (physics pose → `Object3D`). Both sides use
  quaternions, Y-up, metres.

**Awkward:**
- **You can't tell what will render** without reading `renderer.ts`. Normal maps, unlit textures,
  Points, double-sided materials and alpha-test all fail silently or with a one-time warning.
- **Two worlds of "the same" settings.** Sky, fog and quality presets live in Bloom; lights and the
  camera live in three.js. The bridge sets `setProceduralSky(false)` in its constructor, so the order of
  my Bloom calls matters.
- **The browser layer is mandatory** even with no DOM: `document.createElement("canvas")`, `fetch`
  for `file://`, blob temp files for embedded textures. It's invisible until it breaks (#2) and adds to
  every build.
- **Vehicle frame conventions** (Jolt +Z forward) vs glTF −Z; see #7.
- **Debugging spans three languages:** a wrong result could come from TS, the Rust FFI or the C++ shim.
  Two of the physics issues were only explainable from `bloom_jolt.cpp`.

## Recommendation: let a three.js developer adopt Bloom systems one at a time

1. **Ship each Bloom system as an adapter that speaks three.js types.** For example
   `@bloomengine/three/physics`: `addStaticMesh(mesh: THREE.Mesh)`, `createVehicle(root: Object3D, {wheels: Object3D[]})`,
   and `bindBody(object3d, body)`, with the renderer copying body → `Object3D` before drawing
   (interpolated). That makes `sync.ts` a library feature you can still opt out of. Same idea for
   `bindVoice(object3d, sound)` (spatial audio follows an object) and `hud` drawing into the bridge's 2D pass.
2. **Make the renderer's capability explicit and testable:** a `renderer.capabilities.bloom` report
   (which material properties and object types are mirrored), and a dev mode that throws, not
   `warnOnce`, when a scene uses something dropped (normalMap, Points, `side`, alphaTest).
   Then pass through what Bloom already supports: normal/ORM/emissive maps
   (`setSceneNodeMaterialTextureHandles` has the slots), the emissive texture for unlit
   materials, `alphaTest`, `InstancedMesh` → Bloom instancing.
3. **One escape hatch per object:** `mesh.userData.bloom = { node: handle }` or `renderer.nodeOf(mesh)`, so
   a three.js developer can call a Bloom scene API (water material, LOD, render layer) on a specific
   mesh without forking the bridge.
4. **Fix the vehicle shim before advertising it:** ray-tester layer, `forward` applied to wheels,
   mass/gearbox/tyre parameters, wheel-contact and gear getters, and a drive-forward smoke test.
5. **Pin a known-good toolchain:** `bloom-three doctor` that checks the Perry version against a
   tested matrix, three's version, and `@bloomengine/web` freshness. Add cached three.js object files, so
   game-code edits don't recompile 1.2 MB of three.js every time.

## Top 5 doc/API improvements that would have helped most
1. Vehicle shim: wheel-ray layer bug (#6) and `forward` (#7), plus a "drive-forward" test.
2. A bridge feature matrix (what's drawn, which material fields) in the README (#11).
3. Toolchain matrix: Perry version, `--march`, `PERRY_RUNTIME_DIR`, `ios-game-loop` for bridge builds (#1, #4).
4. Exported gamepad constants and a correct multi-touch helper (#13, #14).
5. Document that vehicle tyre grip = √(chassis friction × ground friction) (#8).
