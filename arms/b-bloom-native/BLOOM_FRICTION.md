# Bloom / Perry friction log

Short entries, in the order I hit them. "Lost" = wall-clock time / build iterations
spent on the issue (a Perry game build is ~60 s on this Mac, so every extra
iteration is expensive).

---

### 1. Root `bloom` index re-exports physics names that do not exist
- **Expected:** `import { createPhysicsWorld, stepPhysics, … } from "bloom"` (they are listed in `src/index.ts`).
- **Actual:** `src/physics/index.ts` only has the Jolt v2 API (`createWorld`, `step`, `createBody`, …). The root
  re-exports `createPhysicsWorld`, `addBoxCollider`, `stepPhysics`, `BodyType`, … which are not defined anywhere.
- **Found:** reading `src/index.ts` next to `src/physics/index.ts` before writing code.
- **Workaround:** import from `bloom/physics` (subpath) only.
- **Lost:** ~5 min, 0 builds.

### 2. No way to get triangles out of a loaded glTF (or to read a binary file via Bloom)
- **Expected:** the track's hidden collider meshes (`col_road`, `col_barriers`, `col_terrain`) could be turned into
  Jolt mesh shapes at runtime (something like `meshShapeFromModel(model, "col_barriers")`).
- **Actual:** `loadModel` returns an opaque handle (mesh count, bounds). No vertex/index access, no node names.
  Bloom's `readFile` is text-only (`read_to_string`).
- **Found:** grepped the FFI manifest in `package.json` and `src/models/index.ts`.
- **Workaround:** `tools/gen-track-data.ts` (Node, build time) parses `track.glb` and writes the collider triangles to
  `resources/track_collision.txt` (integer millimetres, welded); the game parses it with a hand-written tokenizer
  (no `split`/`parseFloat`, per Perry quirk #5). Later I found Perry's own `fs` has `readFileBuffer`, so a runtime
  GLB parser would also have been possible.
- **Lost:** ~25 min.

### 3. Mesh index ↔ glTF node mapping is undocumented; colliders are loaded as render meshes
- **Expected:** a way to address `wheel_FL`, `body`, `brake_lights`… by name, and the loader to honour
  `KHR_node_visibility` / `extras.collider` (the asset README says engines should skip them).
- **Actual:** the loader flattens every primitive into one list; hidden collider nodes are loaded and only
  disappear because their material is alpha-MASK 0. The order is "glTF mesh index → node placement (scene walk
  order) → primitive", which I had to read out of `native/shared/src/models_gltf.rs`.
- **Workaround:** hard-coded primitive indices (car: 19, track: 21), confirmed at runtime via `model.meshCount`;
  one scene node per primitive via `attachModelToNode`, colliders never attached.
- **Lost:** ~15 min (source reading), 1 build.

### 4. `KHR_materials_variants` is not supported
- **Expected/Actual:** as expected from the README's fallback note. `setSceneNodeMaterialTextureHandles(node,
  { baseColor })` on the paint primitive's node swapped the livery first try. Good API.
- **Lost:** 0.

### 5. No body mass setter
- **Expected:** `BodyConfig.mass` (the car should weigh 1420 kg).
- **Actual:** mass comes from shape volume × Jolt's default density (1000 kg/m³), so the box chassis weighs several
  tonnes. Not documented in `physics.md`.
- **Workaround:** read `getBodyMass()` and scale every vehicle force (suspension, tyres, drive) by it.
- **Lost:** ~10 min.

### 6. `physics.md` says raycast normals are always (0,1,0)
- **Actual:** the C++ shim computes the real surface normal via a body lock. Doc is stale. (I did not depend on it.)
- **Lost:** ~2 min.

### 7. Fixed-step `physics.step()` cannot drive a force-based vehicle
- **Expected:** a hook to apply per-substep forces (vehicle suspension/tyres must be re-applied every solver step).
- **Actual:** `step()` runs up to 4 internal substeps with no callback; forces applied before it only act on the
  first one.
- **Workaround:** own 60 Hz accumulator calling `stepVariable(world, 1/60)` per step, own render interpolation
  (prev/current transform per car).
- **Lost:** ~5 min (design time only).

### 8. `perry/system` (preferences) does not link in a Bloom game
- **Expected:** `preferencesGet/Set` from `perry/system` (documented in the Perry book) for the best-lap save.
- **Actual:** `Undefined symbols: _perry_system_preferences_get / _set` at link — the module lives in Perry's UI
  runtime, which a Bloom (non-`perry/ui`) app doesn't link. Bloom's own `writeFile` is not usable on iOS either (it
  deliberately does not resolve to a writable directory, per `docs/ios-target.md`).
- **Workaround:** Node-style `fs` + `os.homedir()` from Perry's stdlib (`~/Library/Application Support/BloomRacer` on
  macOS, `Documents/` on iOS).
- **Lost:** 1 build (~1 min) + 5 min.

### 9. No sky-background API; mesh winding/culling convention undocumented
- **Expected:** set the equirect sky PNG as the background (the asset set ships one).
- **Actual:** `setEnvClearFromHdr` only averages an `.hdr` into a clear colour; there is a procedural sky but no
  texture sky.
- **Workaround:** `src/sky.ts` builds an inward-facing UV sphere with `createMesh`, emissive sky texture, follows the
  camera. The first winding I picked was culled (invisible); which winding is front-facing for `createMesh`
  geometry is not documented anywhere.
- **Lost:** 3 builds, ~10 min.

### 10. Spurious Perry parse warnings
- `Parse warning: Error { error: (…, ConstDeclarationsRequireInitialization) }` on ordinary typed, initialised
  `const` declarations (e.g. `export const GEAR_TOP_KMH: number[] = [...]`). The code compiles and runs correctly.
  The warning names no file, so finding which declaration it means required byte-offset hunting.
- **Lost:** ~5 min.

### 11. Engine sources don't type-check under strict `tsc`
- `node_modules/bloom/src` fails `tsc --strict` (no types for `perry/thread`, wrong arg counts in
  `models/index.ts`), and `Model` is used by `bloom/models` but only exported from `bloom/core`.
- **Workaround:** `src/types/perry-env.d.ts` (ambient `perry/*`, `fs`, `os`, `process`) and
  `tools/typecheck.sh`, which only reports errors in the game's own `src/`.
- **Lost:** ~5 min.

### 12. iOS builds link the macOS Perry stdlib
- **Expected:** `perry compile … --target ios` (and `ios-simulator`) to pick the iOS runtime/stdlib.
- **Actual:** `ld: building for 'iOS', but linking in object file (…/target/release/libperry_stdlib.a…) built for
  'macOS'`. The iOS-device stdlib exists in `target/aarch64-apple-ios/release`; the simulator one doesn't exist.
- **Found:** linker error; `PERRY_RUNTIME_DIR` is only mentioned in the watchOS docs.
- **Workaround:** `PERRY_RUNTIME_DIR=<perry>/target/aarch64-apple-ios/release perry compile … --target ios`.
  Simulator build abandoned (would require building Perry's stdlib for the simulator).
- **Lost:** 3 builds × ~1.5 min + ~10 min.

### 13. iOS output directory must exist; unrelated provisioning profile gets embedded
- `-o dist/ios/BloomRacer` fails with `ld: open() failed, errno=2` if `dist/ios/` doesn't exist (macOS builds
  create it).
- With no profile configured for the bundle id, Perry embedded an unrelated development profile found in
  `~/.perry/` (a different app id) into the `.app`. That can never sign this bundle, and nothing warns about it.
- **Lost:** 1 build + ~5 min.

### 14. Particles need a hand-written WGSL material, and the engine has no example
- `createParticleSystem` simulates, but drawing needs `compileMaterialInstancedBucket(wgsl, …)` against the
  5-bind-group material ABI. No example in `engine/examples`. Skipped tyre smoke / nitro flames for time.
- **Lost:** ~5 min (reading), feature dropped.

### 15. Docs vs. reality, minor
- iOS reports pixels, macOS points (EN-024, documented). I designed the HUD in height-relative units from the start,
  so no time was lost — good that this is documented.
- `Color` in `bloom/core` is both a value (colour palette) and a type, depending on the import path.

### 16. A top-level `resources/` folder makes the iOS bundle unsignable
- **Expected:** Bloom's iOS doc says Perry bundles `assets/`, `logo/`, `resources/`, `images/` — so `resources/` is a
  natural place for generated data next to the read-only `assets/`.
- **Actual:** Perry copies it to `BloomRacer.app/resources/`. On the case-insensitive APFS volume that collides with
  the reserved `Resources` bundle directory, and `codesign` fails with the misleading
  `code object is not signed at all — In subcomponent: …/embedded.mobileprovision` (or `bundle format
  unrecognized`). The folder list is hard-coded in `crates/perry/src/commands/compile/bundle_ios.rs`.
- **Found:** bisected on a copy of the bundle (removing the profile → "bundle format unrecognized"; renaming
  `resources` → signs and verifies).
- **Workaround:** `tools/package-ios.sh` renames it to `gamedata/` inside the bundle; `src/paths.ts` picks the
  folder per platform.
- **Lost:** ~20 min.

### 17. `perry compile --target ios` doesn't sign or apply all `[ios]` settings
- Output is unsigned even with `signing_identity`/`provisioning_profile` set in `perry.toml` (signing only happens in
  `perry run`). `[ios] category` is not written to `Info.plist`.
- **Workaround:** `tools/package-ios.sh` patches `LSApplicationCategoryType` (games) and
  `GCSupportsControllerUserInteraction`, embeds the profile, signs with the profile's entitlements, installs and
  launches with `devicectl`.
- **Lost:** ~10 min.

### 18. `perry setup ios --development` fails on accounts with an Apple TV / Watch registered
- Non-interactive, it silently picks the *first* paired device (an Apple TV here). Interactive with the iPhone
  selected, profile creation still fails: `HTTP 409 … Invalid deviceClass for profile type` — it apparently adds
  every registered device (incl. Apple TV/Watch) to an `IOS_APP_DEVELOPMENT` profile.
- **Workaround:** created the profile directly with the App Store Connect API (iPhone + iPad only) using the API
  key Perry already stores, saved as `~/.perry/com_skelpo_bloomracer_dev.mobileprovision`.
- **Lost:** 3 runs, ~15 min.

### 19. macOS: no `.app` for non-`perry/ui` programs; assets resolve against the cwd
- `-o Name.app` writes a plain executable *named* `Name.app` with `assets/` copied beside it. Bloom's macOS asset
  resolver is the identity (cwd-relative), and Finder launches apps with cwd `/`.
- **Workaround:** `tools/package-macos.sh` assembles `Contents/{MacOS,Resources}` + `Info.plist`; the game
  `chdir`s to `Contents/Resources` when it detects it runs inside a bundle.
- **Lost:** ~10 min.

### 20. Build times are dominated by the Perry cache, not by game code
- Clean game build (Perry cache removed, engine static lib already built): **267 s**. Incremental one-line change:
  **~5–6 s**. During development, though, many edits to imported modules still triggered ~60 s builds. The shooter's
  quirks doc warns that edits to imported-only modules can be missed, so every tuning change was verified
  through log output or `--selftest`, not assumed.

---

## Browser (WASM) port, 9 Nov 2026

Bloom's web target (`perry --target wasm` for the game, wasm-pack for the engine, JoltPhysics.js for physics)
compiled the game in 3 s on the first try. Getting it to *run correctly* is what took the time: none of the issues below
produced a compile error, and most failed silently. Tested in headless Chrome over DevTools (WebGPU).

### 21. Perry wasm: class field initialisers skipped when a class has no constructor
- **Actual:** in `class RaceCamera { cam: Camera3D = {...}; ... }` (no `constructor`) every field is `undefined`
  on wasm, so `beginMode3D` got an undefined camera: no 3D at all, only the 2D HUD on a grey screen. Classes with
  an explicit constructor work.
- **Workaround:** `constructor() {}` in `camera.ts`.
- **Lost:** ~40 min (it looked like a renderer problem; bisected render settings first).

### 22. Perry wasm: `this.field.push(x)` is a no-op
- **Actual:** the car's 18 scene-node handles were pushed with `this.nodes.push(n)`: the array stayed empty, so cars
  were never transformed and materials went to `undefined` handles. `const a = this.nodes; a.push(n)` and
  `obj.field.push(x)` from outside work.
- **Workaround:** local alias in `vehicle.ts` and `race.ts` (`finishOrder`).
- **Lost:** ~15 min.

### 23. Perry wasm: postfix `obj.field++` is a no-op; prefix `++obj.field` emits invalid wasm
- **Actual:** `car.lap++` / `car.cpTotal++` did nothing: laps never counted, positions were wrong, races never ended.
  `++this.c` makes the module fail validation at load (`expected 1 elements on the stack for fallthru, found 3`).
  `+= 1` and local `x++` work.
- **Workaround:** `+= 1` in the three places that used a member `++`.
- **Lost:** ~15 min.

### 24. Perry wasm: object passed to Bloom's `setSceneNodeMaterial(h, material = {})` arrives empty
- **Actual:** every field reads `undefined` inside the engine function, so all nodes got the default material
  (sky dome not emissive, brake lights dead). `setSceneNodeMaterialTextureHandles(h, {...})` (no default parameter)
  receives its fields fine; the same pattern between two game modules also works.
- **Workaround:** `src/material.ts` (scalar `setSceneNodeColor` / `setSceneNodePbr` + the declared
  `bloom_scene_set_material_emissive` FFI).
- **Lost:** ~20 min.

### 25. Perry wasm: arrays filled with multi-argument `push(a, b, c, …)` come out wrong
- **Actual:** the sky dome (built with `verts.push(x, y, z, …12 values)`) rendered as huge stray triangles slicing
  through the scene, hiding parts of the cars and all of the sky. Bloom's `createMesh` doc mentions a related
  `.length` bug; `createMeshExplicit` alone did not fix it.
- **Workaround:** preallocated arrays with index writes in `sky.ts`.
- **Lost:** ~45 min (looked like culling, then occlusion, then depth precision).

### 26. Perry wasm runtime never frees object handles
- **Actual:** `allocHandle()` registers a new `handleStore` entry each time an object crosses into JS, including
  objects it already knows (the same `Car` was re-registered ~100×/s), and never deletes any. At ~105k handles/s the
  Map hit V8's limit after ~160 s: `RangeError: Map maximum size exceeded`, right at the end of a race.
- **Workaround:** the build post-processes Perry's page so `allocHandle` reuses the handle of an already-registered
  object (WeakMap), and the hot paths stopped allocating: `src/physfast.ts` (scalar physics FFI into reused
  objects), pooled HUD colours/rects, cached touch layout. 105k → ~480 handles/s (hours of play, ~170 MB/h).
- **Lost:** ~30 min.

### 27. Bloom web physics bridge (`native/web/jolt_bridge.js`) doesn't match the JoltPhysics.js API
Each of these broke the game in the browser; all are fixed at build time by `tools/patch-jolt-bridge.py` on the copy
in `dist/web`, so the engine checkout stays untouched:
- `CompoundShapeSettings.AddShape` / `OffsetCenterOfMassShapeSettings` / `ScaledShapeSettings` take `ShapeSettings`,
  but the bridge passes built `Shape`s → `RuntimeError: null function` on the first compound shape.
- `BodyLockRead/BodyLockWrite` and `Body.GetMotionPropertiesUnchecked` are not bound → crash on `setLinearDamping`.
- The `BodyID` returned by `CreateAndAddBody` is a shared emscripten temporary; storing it made **every body alias
  the last one created** (all positions identical).
- `BodyInterface.GetInverseMass` doesn't exist → mass 0, and the game scales every force by mass (cars stood still).
- Contact-listener callbacks get raw pointers (`body1.GetID is not a function`), and the contact queue was never
  cleared per step (unbounded growth; native drains it every step).
- `AddForce(id, force, point)` with 3 args dispatches to the `(id, force, activation)` overload: every force acted at
  the centre of mass, so tyre forces produced no yaw and **cars couldn't steer**.
- `raycast` ignored `layerMask` (suspension rays would hit the car's own chassis) and returned a fixed (0,1,0) normal.
- `vec3()/rvec3()/quat()` allocated on Jolt's heap per call and never freed: `Aborted(OOM)` after ~5.5 min.
- **Lost:** ~1 h 15 min in total. These look untested against the npm JoltPhysics.js build.

### 28. Bloom web: `bloom_scene_attach_model` dropped the glTF node placement
- **Actual:** the web crate had an older hand-written copy that cloned raw vertices and ignored the primitive's node
  transform (native uses the shared `attach_model_mesh(…, source_transform, …)`). Wheels sat at the model origin and
  orbited their pivot when spinning (a tyre floating above the roof).
- **Fix (engine source):** web now calls `attach_model_mesh` like native; `tools/bloom-web-attach-model.patch`.
  `build-web.sh` warns if the engine tree lacks it.
- **Lost:** ~25 min.

### 29. Smaller web gaps
- Web model loading gets bytes only, so `track.glb`'s external `../textures/*.png` can't resolve → the build embeds
  them into a self-contained copy (`tools/embed-glb.ts`).
- `process.argv` is empty on web → test flags come from the URL query (`?autopilot&autostart`), handed over through
  Bloom's localStorage-backed `readFile`.
- `bloom-web`'s build script copies the whole `assets/` folder and emits no `assets_manifest.json` (so no prefetch;
  and the glue's sync XHR for binary files fails with `InvalidAccessError` in Chrome) → own `tools/build-web.sh`.
- Perry's `fs`/`os` imports compile for wasm but can't be used → Bloom's localStorage `writeFile` on web.
- **Lost:** ~15 min.

---

## Top 5 doc / API improvements that would have helped most

1. **Model introspection:** node name → primitive index, node local transforms/extras, and
   `meshShapeFromModel(model, nodeName)` / `convexHullFromModel(...)` so glTF collider nodes go straight into Jolt.
   This would have removed the build-time extractor and the hard-coded primitive indices. Also skip
   `KHR_node_visibility {visible:false}` nodes when rendering.
2. **Fix the root `bloom` export list and make `src/` pass strict `tsc`** (ship `perry/*` ambient types). The
   first thing a TypeScript user does is type-check.
3. **Perry iOS/macOS packaging:** select the target's runtime/stdlib automatically (or document `PERRY_RUNTIME_DIR`),
   ship simulator libs, create the output dir, never bundle a top-level `resources/` (or rename it), sign with the
   configured profile, only add matching device classes in `setup ios --development`, and produce a real `.app`
   for Bloom games on macOS. These cost more time than any engine API gap.
4. **Vehicle-friendly physics:** `BodyConfig.mass` (or `setBodyMass`) and a per-substep callback for `step()`
   (or document the `stepVariable` + own-accumulator pattern for force-driven vehicles).
5. **Rendering conventions + recipes:** document front-face winding/culling for `createMesh`/scene nodes, add an
   equirect sky-texture background, and ship one particle example material (smoke) next to `vfx/index.ts`.
