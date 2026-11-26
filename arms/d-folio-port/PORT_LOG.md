# Port log: folio-2025 → native (Perry + Bloom three.js bridge)

`brunosimon/folio-2025` at `70764a94756cc4de564e493c8ba46c4b5fe03ed1` (branch `port`). The game source in
`sources/` is compiled by **Perry** (built from `main`, 1095f50fc5) and runs on **@bloomengine/three**
(0392aa5) + **@bloomengine/web** (fcba110) + **@bloomengine/engine** (4b02b90). Everything native lives in `bloom/`.
Predictions are in `INVENTORY.md`; the comparison is at the end of this log.

| File | Lines | |
|---|---:|---|
| `bloom/main.ts` | – | native entry: `config.ts` → `@bloomengine/web` → `shims.ts` → the game's `index.js` |
| `bloom/config.ts` | – | window, staged site, canvas, storage |
| `bloom/shims.ts` | – | browser APIs the bridge lacks (XHR, `window.open`, …) |
| `bloom/three-webgpu.ts` + `renderer.ts` | – | `three/webgpu`: the real WebGPU build with the bridge's renderer, adapted |
| `bloom/rapier.ts` | – | `@dimforge/rapier3d` on Bloom's Jolt (the swap) |
| `bloom/alias/*.ts` | – | module aliases: seedrandom interop, `three/src` deep imports, Draco/KTX2 loaders |
| `bloom/stage.mjs` | – | site staging: `static/` + `index.html` + compiled Stylus, Draco decode, `import.meta.env` |
| `bloom/build.sh` | – | `perry compile` with the bridge's aliases plus this port's |
| `sources/` (the game) | **0** | |

Levels: 1 = already works · 2 = small shim/adapter · 3 = swap a dependency · 4 = rewrite a module.

## Entries

### 1. `import … from 'seedrandom'`: no named export `alea`
- **What:** `Error: The requested module 'seedrandom' does not provide an export named 'alea'`. seedrandom is CommonJS, and Vite/esbuild expose `module.exports.alea` as a named export. Perry doesn't.
- **Category:** `perry-compiler` · **Level:** 2
- **Fix:** module alias `seedrandom` → `bloom/alias/seedrandom.ts` (re-exports `alea` from the real module). 4 lines.
- **Bridge automatically?** **yes** (Perry). CJS named-export interop (cjs-module-lexer style) is what every bundler does, and many npm packages rely on it.

### 2. Deep imports of `three/src/…` load a second three.js
- **What:** `three/src/math/MathUtils.js` (`clamp`, 5 files) and `three/src/renderers/common/CubeRenderTarget.js` (`PreRenderer.js`) pull three's *source tree* into the graph next to the `three.core.js` build. Under Vite they resolve to the same files as the build's dev mode; here they'd be a second set of classes (`instanceof` mismatches).
- **Category:** `three-api` · **Level:** 2
- **Fix:** both aliased to `bloom/alias/three-src.ts`, which re-exports `MathUtils.clamp` and `CubeRenderTarget` from `three/webgpu`. 7 lines.
- **Bridge automatically?** yes. `bloom-three aliases` could map `three/src/*` to the build's exports for the common deep imports.

### 3. `three/webgpu` is mapped to the WebGL build
- **What:** `bloom-three aliases` maps `three/webgpu` to the bridge's `three.ts`, which re-exports `three.module.js` (core + WebGL). That has none of what this game imports from `three/webgpu`: `MeshLambertNodeMaterial`, `MeshBasicNodeMaterial`, `SpriteNodeMaterial`, `RenderPipeline`, `QuadMesh`, `RenderTarget` features, `StorageInstancedBufferAttribute`, `TimestampQuery`. `three/tsl` itself imports from `three/webgpu`.
- **Category:** `three-api` · **Level:** 2
- **Fix:** `bloom/three-webgpu.ts` re-exports the real `three.webgpu.js` (it shares `three.core.js` with the bridge) and replaces `WebGPURenderer` and `RenderPipeline` (entries 4, 5). `build.sh` drops the bridge's `three/webgpu` alias and adds this one. 9 lines.
- **Bridge automatically?** **yes**. Every WebGPU/TSL three.js game imports `three/webgpu`. The bridge should alias it to the WebGPU build, not the WebGL one.

### 4. DRACOLoader and KTX2Loader need WebAssembly in workers
- **What:** link error `this WebAssembly program links libperry_wasm_host.a`: `DRACOLoader` probes `typeof WebAssembly`, and both loaders start Web Workers (`ERR_WORKER_NOT_COMPILED` warnings). 14 of the 32 plain `.glb` models are Draco-compressed. KTX2 is only used when `VITE_COMPRESSED` is set, which it isn't.
- **Category:** `wasm` · **Level:** 2
- **Fix:** `stage.mjs` decodes the Draco models once at staging (gltf-transform + draco3dgltf, both already dependencies of the repo). The two loaders are aliased to stand-ins (`bloom/alias/wasm-loaders.ts`, 30 lines) that accept the setup calls and fail loudly if a file ever needs them.
- **Bridge automatically?** yes. Draco is the most common glTF compression. The bridge's GLTFLoader could decode Draco natively in Rust (draco is C++), or `bloom-three` could pre-decode models at build time.

### 5. `WebSocket` needs Perry's `net`/`ws` extension archives
- **What:** link errors `` `net` links the prebuilt wrapper archive libperry_ext_net.a `` and the same for `perry/websocket` (`libperry_ext_ws.a`). They aren't shipped with a source-built Perry, and its updater can't download them. The game constructs a `WebSocket` (multiplayer whispers), though only when `VITE_SERVER_URL` is set.
- **Category:** `perry-compiler` · **Level:** 1 (toolchain)
- **Fix:** `cargo build --release -p perry-ext-net -p perry-ext-ws` in the Perry checkout. 0 project lines.
- **Bridge automatically?** n/a (Perry tooling). A source build of Perry should build the extension archives a program needs, as it does for the runtime.

### 6. `import.meta.env` is undefined
- **What:** `TypeError: Cannot read properties of undefined (reading 'VITE_…')` (12 uses in 8 files). `perry compile --define 'import.meta.env={…}'` is rejected: `invalid define key "import.meta.env": expected an identifier or dotted identifier`.
- **Category:** `perry-compiler` · **Level:** 2
- **Fix:** do what `vite build` does. `stage.mjs` writes the game's `.js` files to `bloom/.build/sources/`, with every `import.meta.env.VITE_X` replaced by its value from `.env`, or `.env.example` when there's none. The native entry imports that copy. 0 game lines, 25 lines of staging. (A2 edited 2 game lines for this instead.)
- **Bridge automatically?** **yes**. Same as A2 entry 4: `bloom-three build` should apply Vite's `import.meta.env` define, and Perry's `--define` should accept `import.meta.*`.

### 7. Site layout: Vite `root` + `publicDir`, Stylus
- **What:** Vite serves `sources/` (`index.html`) and `static/` (`publicDir`) as one site and compiles `<link href="./style/index.styl">` on the fly. `@bloomengine/web` serves one folder and reads CSS only.
- **Category:** `asset-loading-fetch` · **Level:** 2
- **Fix:** `stage.mjs` stages `static/` (without the `-compressed` variants, KTX, basis/draco decoders, favicons) plus `index.html` into `bloom/assets/folio/`, and writes the Stylus sheets compiled to CSS at `style/index.styl`, the URL the page links. Stylus passes its `@import url(…)` through as CSS `@import`, so the sheets are compiled one by one in the index's order. 195 MB staged. About 50 lines.
- **Bridge automatically?** yes. Root + `publicDir` lookup (A2 entry 5). CSS preprocessors are a Vite plugin concern, but `bloom-three` could run the project's Vite CSS pipeline.

### 8. Rapier is WebAssembly: swapped for a Rapier-shaped facade on Bloom's Jolt
- **What:** `@dimforge/rapier3d` is wasm-bindgen glue around a `.wasm` module (imported through `vite-plugin-wasm`). Perry has no WebAssembly engine by default, and its wasmi host only runs a numeric subset. The game uses Rapier for everything that moves: the car (`DynamicRayCastVehicleController`), about 300 physical props, the terrain heightfield, kinematic platforms and contact-force events for hit sounds.
- **Category:** `physics-engine` · **Level:** 3
- **Fix:** module alias `@dimforge/rapier3d` → `bloom/rapier.ts`, the subset of Rapier's API the game calls, implemented on `@bloomengine/engine/physics` (Jolt):
  - **Bodies:** a body with its colliders becomes one Jolt body (a static compound).
  - **Shapes:** cuboid, ball, cylinder, trimesh, convex hull, and heightfield (transposed from Rapier's column-major layout).
  - **Collision groups:** mapped to Jolt object layers with a computed collision matrix.
  - **Enable/disable:** `setEnabled(false)` removes the Jolt body and enabling recreates it.
  - **Kinematic bodies:** `setNextKinematicTranslation` maps to `moveKinematic`.
  - **Contact-force events:** built from Jolt's contact-added events, with the force estimated from the approach speed.
  - **The car:** Rapier's ray-cast vehicle (Bullet's `btRaycastVehicle`) is ported line by line onto Jolt raycasts and impulses.
  - **Masses:** Jolt has no mass setter (mass = volume × 1000 kg/m³), so the facade keeps Rapier's masses and inertias and converts every impulse so that it changes velocity as Rapier would.

  About 700 lines. 0 game lines.
- **Bridge automatically?** **yes**. Rapier (with its vehicle controller) and cannon-es are the two physics engines of web three.js games. A Rapier-compatible module over Jolt shipped with the bridge (or Rapier compiled natively and bound to Perry) would make the most common physics dependency work unchanged. Bloom's physics would also need a **mass/inertia override** on bodies; without it, contacts between bodies of different densities can't match Rapier (entry 21).

### 9. Perry: calling a builtin held in an IIFE's local fails (GSAP)
- **What:** `TypeError: value is not a function` while GSAP's module initialises. Minimal repro: `var h = function () { var a = Math.max; return a(1, 2); }();` throws. The same code in a function that isn't immediately invoked works, and so does `.call(this)` instead of `()`. GSAP's ticker IIFE starts with `var _getTime = Date.now, _startTime = _getTime()`.
- **Category:** `perry-compiler` · **Level:** 2
- **Fix:** `stage.mjs` writes a copy of GSAP's ES modules with that one alias wrapped (`function () { return Date.now(); }`), and `gsap` is aliased to it. 1 line patched in a copy, about 20 lines of staging.
- **Bridge automatically?** n/a. It's a Perry codegen bug (IIFE inlining loses builtin function values), and GSAP is the most used animation library on the web. **Reported as a finding for Perry.**

### 10. Perry: Howler's spatial plugin sees its CommonJS exports in the TDZ
- **What:** `ReferenceError: Cannot access 'Howl' before initialization` while `howler.js` loads. Its second IIFE (the spatial plugin) reads `Howl`, `HowlerGlobal` and `Sound` as globals, which the first IIFE publishes with `global.Howl = Howl`. Perry resolves those free names to the CommonJS module's own exports, in their TDZ. A two-IIFE repro in a plain script doesn't reproduce it, so it's specific to a CJS module with `exports.X` / `global.X`.
- **Category:** `perry-compiler` · **Level:** 2
- **Fix:** `stage.mjs` writes a copy of `howler.js` whose plugin IIFE starts with `var HowlerGlobal = globalThis.HowlerGlobal, Howler = …, Howl = …, Sound = …;`, and `howler` is aliased to it. 1 line, about 12 lines of staging.
- **Bridge automatically?** n/a (Perry). Howler is the most used web audio wrapper.

### 11. Perry: `new ImportedClass(...array)` passes the array as one argument
- **What:** every TSL constant colour came out white: `color('#383039')` → `#ffffff`. Repro: in module B, `import { Color } from './a.js'; new Color(...['#383039'])` makes the constructor receive `(['#383039'])`. A local alias (`const C = Color; new C(...p)`) and `Reflect.construct` both work. three.js's TSL builds all constant values that way (`new Color( ...params )`, `Vector2/3/4`, `Matrix2/3/4`), so every `vec3(…)`/`color(…)` constant is wrong.
- **Category:** `perry-compiler` · **Level:** 2
- **Fix:** `stage.mjs` writes copies of `three.tsl.js` (7 calls changed to `Reflect.construct`) and `three.webgpu.js` (which imports it), both still on the real `three.core.js`. `three/tsl` and the WebGPU build are aliased to them. About 20 lines of staging.
- **Bridge automatically?** n/a (Perry). This one would silently break any TSL/WebGPU three.js game on Perry. **Reported as a finding for Perry.**

### 12. Renderer: the WebGPURenderer API the game calls
- **What:** in turn: `setOpaqueSort is not a function`, `renderer.backend` undefined, `getRenderObjectFunction is not a function` (three's `RendererUtils.resetRendererState`, used around the noise passes), `getMRT`, `computeAsync`, `resolveTimestampsAsync`, `hasFeature`.
- **Category:** `three-api` · **Level:** 2
- **Fix:** `bloom/renderer.ts` subclasses the bridge's renderer (`FolioRenderer`): `backend` (neither WebGPU nor WebGL, which also skips the cube-map pre-render), state accessors (`MRT`, render-object function, `opaque`/`transparent`), no-op sorts, compute and timestamps. About 40 lines.
- **Bridge automatically?** **yes**. The bridge already exports its renderer as `WebGPURenderer`, but implements only the WebGL renderer's surface.

### 13. Renderer: offscreen renders replace the frame
- **What:** the game renders into `RenderTarget`s (tire tracks every frame; noise textures, snow elevation and voronoi at startup, through `QuadMesh.render`). The bridge warns "render targets aren't supported: drawing goes to the window" and draws those scenes as the frame, which hides the main scene's nodes.
- **Category:** `three-api` · **Level:** 2 (feature not ported)
- **Fix:** `FolioRenderer.render` does nothing while a render target is set. 4 lines. The textures those passes would produce stay empty: no tire tracks, no noise-driven effects.
- **Bridge automatically?** **yes**. At minimum, skip rather than mis-draw. Better, render the target with Bloom offscreen and expose it as a texture.

### 14. Renderer: `RenderPipeline` (post-processing) and `scene.backgroundNode`
- **What:** `new THREE.RenderPipeline(renderer)` with `pass()` + `bloom()` + a custom depth-of-field node, and a background that is a TSL node (a gradient of the day cycle's two fog colours).
- **Category:** `three-api` · **Level:** 2
- **Fix:** a `RenderPipeline` stand-in that finds the `pass()` node in the output graph and renders its scene and camera. Bloom applies its own post-processing (bloom, TAA) by quality preset. The background node clears to the average of its colours, every frame. About 45 lines.
- **Bridge automatically?** **yes**. `pass(scene, camera)` → render is the 90 % case of three's post-processing graphs.

### 15. Renderer: node materials draw white
- **What:** every material in the game is a TSL node material (`MeshLambertNodeMaterial` subclass `MeshDefaultMaterial`, `MeshBasicNodeMaterial`, …) whose colour is a node graph: `texture(palette).rgb`, `color('#…')`, `uniform(color(…))`, or a `Fn(() => …)()` body. The bridge reads `material.color` (white) and `material.map` (null).
- **Category:** `three-api` · **Level:** 2
- **Fix:** `translateMaterial` in `renderer.ts` walks the colour node (`_colorNode`, `colorNode`, else `outputNode`) for the first texture (skipping render-target textures) and the first colour, and sets them as `map`/`color` for the bridge. `Fn` calls are expanded by running their body once on a scratch TSL stack (`setCurrentStack`), exactly what TSL does at shader build time. About 110 lines. It recovers the palette texture of every glTF model, the road's asphalt, the emissive colours and the canvas-text textures. Anything computed per pixel is lost: gradients, the toon shading, fog, the water line, the reveal circle.
- **Bridge automatically?** **yes, the biggest one for WebGPU games**. A TSL-to-Bloom material translator (colour/map/emissive/opacity from the node graph) belongs in the bridge. Beyond that, Bloom would need a way to run (or transpile) TSL's WGSL output.

### 16. Renderer: `InstancedMesh` isn't drawn
- **What:** the physics props (benches, fences, bricks, lanterns, crates, cookies), trees, bushes and flowers are `InstancedMesh`es (the game's `InstancedGroup`). The bridge drew the base geometry once at the mesh's transform.
- **Category:** `three-api` · **Level:** 2
- **Fix:** `FolioRenderer` draws up to 96 instances as one scene node each (transform-only updates for moving props), and larger counts as one geometry with the instances baked in, rebuilt when `instanceMatrix` changes. About 70 lines.
- **Bridge automatically?** **yes** (A2 entry 12 too). Bloom needs real instancing in the scene API; per-instance nodes are a stopgap.

### 17. Renderer: bounding spheres are never computed
- **What:** `Cannot read properties of null (reading 'center')` in CookieArea, which waits a few frames and then adjusts `geometry.boundingSphere`. three's renderers compute bounding spheres while frustum culling; the bridge doesn't cull.
- **Category:** `three-api` · **Level:** 2
- **Fix:** compute a missing bounding sphere when a mesh is first synced. 3 lines.
- **Bridge automatically?** **yes**, trivially.

### 18. `getBoundingClientRect` before the first frame is 0×0, so the camera is NaN
- **What:** nothing 3D on screen, just a flat colour. `Viewport.measure()` runs in `Game.init`, before the page has been laid out once, and `.game` measured 0×0. The camera aspect became `0/0`, and every matrix derived from it was NaN. A browser lays out synchronously on demand.
- **Category:** `dom-html-css-hud` · **Level:** 2
- **Fix:** `shims.ts`: an element without a layout box yet, that is `position: fixed` or (before any styles are computed) a child of `<body>`, measures as the viewport. About 25 lines.
- **Bridge automatically?** **yes**. `getBoundingClientRect`/`clientWidth` should lay out on demand when the page is dirty, as browsers do. Every game that sizes its renderer from a container element at startup hits this.

### 19. Small browser APIs: `XMLHttpRequest`, `strokeText`, `window.open`
- **What:** Howler loads sounds with `XMLHttpRequest` (absent). The altar counter calls `context.strokeText` (absent: `TypeError`). The project, lab and social links call `window.open(url)`.
- **Category:** `asset-loading-fetch` / `dom-html-css-hud` / `other` · **Level:** 2
- **Fix:** `shims.ts`: an `XMLHttpRequest` over `fetch` (GET; arraybuffer, text or JSON responses; load, error and readystatechange events), about 50 lines. `strokeText` draws the text filled in the stroke colour, 12 lines. `window.open` runs `/usr/bin/open` on macOS and logs elsewhere, 10 lines. (`perry/system`'s `openURL` needs Perry's UI library, which would put a second app framework next to Bloom's window: link error `_perry_system_open_url`.)
- **Bridge automatically?** **yes** for all three. XHR is still used by many loaders and libraries, and `window.open` should map to the platform's URL opener.

### 20. KTX2 images loaded directly
- **What:** the projects, lab and intro areas call `KTX2Loader` themselves, whatever `VITE_COMPRESSED` says ("needs a WebAssembly decoder").
- **Category:** `asset-loading-fetch` · **Level:** 2
- **Fix:** the KTX2 stand-in (entry 4) loads the `.png` the game ships next to every `.ktx`, with `flipY` off as for a KTX texture. 10 lines.
- **Bridge automatically?** yes. Bloom can load KTX2/Basis natively (Rust `basis-universal` / `ktx2` crates). A native `KTX2Loader` would remove the WebAssembly transcoder.
