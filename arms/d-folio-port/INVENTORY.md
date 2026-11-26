# Inventory: folio-2025 → native (Perry + Bloom three.js bridge)

Written **before any change**. The game is `brunosimon/folio-2025` at commit `70764a94756cc4de564e493c8ba46c4b5fe03ed1`
(2026-11-04, "Bump up dependencies (not Rapier because of sleep bug)"). The port is on branch `port`.

It is Bruno Simon's 2025 portfolio: an open world you drive a small car around. It has physics props, areas with
interactive points (projects, lab, career, social), a time-trial circuit, bowling, achievements, day, year and weather
cycles, a jukebox playlist, a map, and optional multiplayer "whispers" over a WebSocket server.

| Metric | Value |
|---|---|
| Source | plain JavaScript, ESM, **~29.7k lines** in 150 files under `sources/` |
| UI | `index.html` (890 lines, about 320 elements) + **Stylus** (`style/*.styl`, 2.5k lines) compiled by Vite |
| Build | Vite 8 (`root: sources/`, `publicDir: ../static/`, `vite-plugin-wasm`, `vite-plugin-node-polyfills`) |
| Assets | `static/`: 1.1 GB. 32 `.glb` plus 32 `-compressed.glb`, 376 PNG and 88 KTX2 textures, 88 MP3 and 3 WAV sounds (151 MB) |

Prediction scale (from the task): **works** = level 1 · **shim** = level 2 · **swap** = level 3 · **rewrite** = level 4.
"✗" marks an item I expect can't reach feature parity at any level without bridge or engine work.

## 1. Rendering stack: the critical path

In the bridge README's terms, this game is about as far from "a normally written three.js game" as one gets. Every
visual is a **TSL node material**, and the pipeline is **WebGPU-only**. The bridge mirrors `Mesh` + `color`/`map`/`emissive`.

| Item | Where | Count | Prediction | Why |
|---|---|---:|---|---|
| `import … from 'three/webgpu'` (the `WebGPURenderer` build: node materials, `RenderPipeline`, `QuadMesh`, `RenderTarget`, storage attributes) | 81 files | 81 | **shim** | `bloom-three aliases` maps `three/webgpu` to the bridge's `three.ts`. That file re-exports `three.module.js` (core + WebGL), which has **no** node materials, `RenderPipeline`, `QuadMesh`, `StorageInstancedBufferAttribute` or `TimestampQuery`. It needs a local `three/webgpu` module: real `three.webgpu.js` + `BloomRenderer` as `WebGPURenderer`. |
| `import … from 'three/tsl'` (`Fn`, `uniform`, `texture`, `positionLocal`, `If`, `Loop`, …) | 54 files | 56 | **works** (compile), ✗ (meaning) | TSL only builds node graphs in JS. That should compile and run under Perry. Bloom never executes the graphs. |
| `WebGPURenderer` + `setAnimationLoop` + `init()` | `Rendering.js` | 1 | **works** | The bridge already exports `BloomRenderer as WebGPURenderer`, with `setAnimationLoop` and `init()`. |
| `renderer.backend.isWebGPUBackend` / `isWebGLBackend`, `setOpaqueSort`, `setTransparentSort`, `resolveTimestampsAsync`, `library`, `computeAsync` | `Game.js`, `Options.js`, `Rendering.js`, `Leaves.js`, `World.js` | 8 | **shim** | These are missing on `BloomRenderer`, so the game throws at startup. Adding no-op members is enough. |
| `THREE.RenderPipeline` + `pass()` + `bloom()` + `cheapDOF` (post-processing) | `Rendering.js` | 1 | **shim**, ✗ | The bridge has no post-processing. Native Bloom has its own bloom/TAA quality tiers. A stub `RenderPipeline.render()` → `renderer.render(scene, camera)` keeps the frame. The custom DOF is lost. |
| **`MeshDefaultMaterial`** (`MeshLambertNodeMaterial` + a custom `outputNode`: palette colour, light bounce, core/drop shadows, fog, water line, reveal circle) | almost every visible mesh | 1 class, used everywhere | **shim** (approximate), ✗ (exact) | The bridge reads `material.color` (white) and `material.map` (null), so everything would draw **white**. The real colour lives in `_colorNode` (usually `texture(palette)` sampled by the glTF's UVs). A small TSL → Bloom translator in the adapter could read `_colorNode` / `colorNode`: a `TextureNode` gives `map`, a constant/uniform `color` gives `color`. Shadows, fog and lighting would then come from Bloom. |
| `MeshBasicNodeMaterial` (53), `MeshLambertNodeMaterial` (8), `SpriteNodeMaterial` (8), `PointsNodeMaterial` (1), `Line2NodeMaterial` (2), `LineBasicNodeMaterial` (1) | world, areas, effects | 73 | **shim** for basic/lambert with a translatable `colorNode`, ✗ for the rest | Most of these are effects (emissive gradients, glows, sprites, lines) whose look is computed in the shader. |
| Vertex-shader animation via `positionNode` (grass, foliage and trees in the wind, water surface, flags, rain lines, snow, tornado, whispers) | `Grass.js`, `Foliage.js`, `WaterSurface.js`, `Snow.js`, `RainLines.js`, `VisualTornado.js`, `Whispers.js`, … | ~15 systems | ✗ (**rewrite** per system) | A `positionNode` is a GPU-side displacement. The bridge uploads static geometry. These systems would draw as their undisplaced base geometry (a flat grass plane, for example) or not at all. |
| **`InstancedMesh`** + `InstancedBufferAttribute` | `InstancedGroup.js` (all physics props: benches, bricks, fences, lanterns, crates, cookies, fans), `Foliage.js`, `Trees.js`, `Flowers.js`, `PoleLights.js`, `Confetti.js`, … | 6 `new`, used by about 20 systems | **shim** | The bridge README says it isn't drawn. An adapter can expand an `InstancedMesh` into one scene node per instance (geometry × `instanceMatrix`). That's fine for props (tens of instances). Foliage and grass have thousands of instances. |
| Compute shaders: `StorageInstancedBufferAttribute`, `instancedArray`, `.compute()`, `renderer.computeAsync` | `Leaves.js`, `RainLines.js`, `Snow.js` | 3 | ✗ | These are GPU particle simulations. Nothing in the bridge runs compute. Disable them. |
| `RenderTarget` + offscreen `renderer.render()` (tire tracks, noise textures, snow elevation) and `CubeRenderTarget`/`CubeCamera` (`PreRenderer`, only on the WebGPU backend at high quality) | `Tracks.js`, `Noises.js`, `Snow.js`, `PreRenderer.js` | 5 | **shim** (no-op), ✗ (feature) | The bridge has no render targets: it warns once and draws into the window. An offscreen `render()` would **overwrite the frame's scene state**, so it has to be swallowed. The noise textures and tire tracks are then lost. |
| `Points`, `Line`, `LineSegments`, `Sprite`, `Line2` | effects, `PhysicsWireframe` (debug), `Bubble`, `Whispers` | ~6 | ✗ | Not drawn by the bridge (it warns once). |
| `DirectionalLight` with shadows; lighting done in the shader (`game.lighting.*Uniform`) | `Ligthing.js` | 1 | **works**, approximately | The bridge maps it to Bloom's sun and shadows. The game's own toon-like shading (core-shadow edges, shadow colour) is lost. |
| Fog (custom TSL fog: `Fog.js`) | `Fog.js` | 1 | ✗ (approximate) | The game sets no `scene.fog`. Bloom's clear colour falls back to `setClearColor` / `scene.background`. |
| `scene.background` / clear colour from day cycles | `DayCycles.js`, `Ligthing.js` | – | **works** if a `Color` is used | – |
| `THREE.Object3D.prototype.copy` override | `threejs-override.js` | 1 | **works** | Prototype method assignment is supported by Perry. |
| `CanvasTexture` / `new THREE.Texture(canvas)` (gradients, `TextCanvas` labels) | `Materials.js`, `TextCanvas.js`, areas | ~10 | **works**, ✗ for text quality | The bridge uploads canvas RGBA. Its 2D context draws `fillText` with a bitmap font and a fixed-width `measureText`, so in-world labels look different. |
| `DataTexture` | `Terrain.js`, others | 4 | **works** | The bridge uploads RGBA data textures. Non-RGBA ones are skipped with a warning. |

## 2. Loaders and assets

| Item | Where | Prediction | Why |
|---|---|---|---|
| `GLTFLoader` | `ResourcesLoader.js` | **works** | The bridge aliases it to its subclass. |
| **`DRACOLoader`** (`KHR_draco_mesh_compression`, used by **16 of the 32 uncompressed `.glb`**: trees, flowers, bricks, fences, pole lights, …) | `ResourcesLoader.js` | **shim** (asset pipeline) | Draco decodes in a **Web Worker running `draco_decoder.wasm`**, and Perry has no WASM engine by default (see below). The fix is to decompress the 16 models at build time with `gltf-transform` (already a devDependency) and stage the decoded copies. No code change. |
| **`KTX2Loader`** (Basis transcoder WASM in a worker; constructed eagerly for the glTF loader, `detectSupport(renderer)`) | `ResourcesLoader.js` | **shim** | `VITE_COMPRESSED` is empty in `.env.example`, so the game loads the **PNG** variants and plain `.glb` and never transcodes KTX2. `detectSupport(renderer)` reads `renderer.hasFeature(...)` / `backend`, which the bridge lacks. Members on the renderer fix that. |
| `TextureLoader` (PNG) | `ResourcesLoader.js` | **works** | It goes through `<img>`, which `@bloomengine/web` maps to Bloom's loader. Note `?cb=1` query strings on every URL. |
| `new Image()` (CircuitArea leaderboard flags, Bubble) | 2 | **works** | – |
| Vite: `import.meta.env.VITE_*` | 9 keys, 11 uses | **shim** | It's undefined under Perry (A2 entry 4). |
| Vite: `index.html` links `./style/index.styl` (**Stylus**), compiled on the fly | `index.html` | **shim** (build step) | `@bloomengine/web` reads CSS only. Precompile with `stylus` (already a dependency) at staging time and rewrite the link in the **staged** copy. |
| Vite: `root: sources/` + `publicDir: static/` served as one site | – | **shim** | Same as A2 entry 5: stage `index.html` + CSS into the served folder. |
| Google Fonts `<link>` (Nunito, Amatic SC) | `index.html` | **shim** | It's remote. Natively there's no font unless `configure({ fonts })` names local files. Pally is local (`@font-face` with `url()`), which works. |
| Analytics `<script>` (gtag) | `index.html` | **works** (ignored) | Inline scripts don't run. That's harmless. |

## 3. Physics

| Item | Where | Prediction | Why |
|---|---|---|---|
| **`@dimforge/rapier3d` 0.19** (wasm-bindgen, imported with `import('@dimforge/rapier3d')` → `.wasm` ESM import via `vite-plugin-wasm`): `World`, `RigidBodyDesc`, `ColliderDesc` (cuboid, ball, cylinder, trimesh, convexHull, heightfield), collision groups, friction combine rules, contact-force events through an `EventQueue`, **`DynamicRayCastVehicleController`** (the car) | `Physics.js`, `PhysicsVehicle.js`, `Objects.js`, `LandingArea.js`, `PhysicsWireframe.js` | **swap** (expensive) | Perry ships no WASM engine by default. The opt-in wasmi host runs only a numeric subset, and the bindgen glue's ESM `.wasm` import isn't a form it lowers. The swap is a Rapier-shaped facade over **Bloom's Jolt** (`@bloomengine/engine/physics`), which has bodies, the same shape set, layers, contact events and a wheeled vehicle. The hard part is the raycast-vehicle controller: Jolt's `WheeledVehicle` isn't Rapier's API, so the facade would have to re-implement Rapier's raycast vehicle (suspension rays, friction slip) on Jolt raycasts and impulses. |

## 4. Audio

| Item | Where | Prediction | Why |
|---|---|---|---|
| **Howler.js** 2.2 (`new Howl({ src: [mp3] })`, `rate`, `volume`, `stereo`/`pos`, `Howler.mute`), about 60 sounds + a 10-song playlist | `Audio.js` | **shim** | Howler's Web Audio path loads with **`XMLHttpRequest`**, which `@bloomengine/web` doesn't provide (it has `fetch`). An XHR shim over `fetch` (arraybuffer only) should let Howler run on the bridge's Web Audio. The `html5: true` path (`new Audio()`) is the fallback. |
| Unlock-on-first-interaction logic | `Audio.js` | **works** | The bridge's `AudioContext` starts running. |

## 5. DOM, CSS, HUD

| Item | Where | Prediction | Why |
|---|---|---|---|
| Large DOM UI: menu, modals, tabs, options, notifications, achievements, map, circuit timer/leaderboard, controls help, interactive buttons; `classList` (104), `querySelector` (96), `innerHTML` (16), `style.*` (62), `dataset` (10), `transitionend` (3) | about 25 files | **works**, mostly | It's the bridge's strongest area. Not drawn: `::before`/`::after` (Stylus uses them for decorations), `filter`/`backdrop-filter` (blurred modal background), rotation transforms, and tables. Expect cosmetic losses. |
| 2D canvas (`getContext('2d')` ×10): `fillText`, `measureText`, `font`, `textAlign`, gradients | `TextCanvas.js`, `Materials.js`, map, areas | **works** (approximate) | Bitmap-font `fillText` (see §1). `drawImage` is missing (A2 entry 7). Check the map. |
| `getBoundingClientRect` (2), `innerWidth/Height`, `devicePixelRatio`, `resize` | `Viewport.js`, map | **works** | – |
| `window.open(url)` (project, lab and social links) | 4 | **shim** | It needs to open the system browser (Perry has `open`-style APIs) or be a no-op. |
| `navigator.userAgent` (mobile test in `Quality.js`, `BlackFriday.js`) | 2 | **works** | The bridge's navigator has a user agent. Verify that iOS reports mobile. |
| `location.hash` (`#debug`, `#stats`, `#skip`, `#inspector`) | 5 | **works** | Empty hash → features off. |
| `Intl.DateTimeFormat().resolvedOptions().locale`, `toLocaleString` | `InputFlag.js`, `Rendering.js` | **works** (Perry) | – |

## 6. Input

| Item | Where | Prediction | Why |
|---|---|---|---|
| Keyboard (`keydown`/`keyup`, `key`/`code`) | `Keyboard.js` | **works** | – |
| Mouse (`mousedown/move/up`, `contextmenu`) and wheel via `normalize-wheel` | `Pointer.js`, `Wheel.js` | **works** | The bridge dispatches mouse events after pointer events, and `WheelEvent`. |
| Touch (`touchstart/move/end`) + a virtual joystick (`Nipple.js`) | `Pointer.js`, `Nipple.js` | **works** (iOS) | The bridge dispatches `TouchEvent`. |
| Gamepad (`navigator.getGamepads()`) | `Gamepad.js` | ✗ | It returns `[]` (A2 entry 16). |
| `camera-controls` (free camera, debug and behind-the-scene only) | `View.js` | **works** (compiles) | It's pure JS. It installs on the `THREE` namespace. |

## 7. Other libraries

| Library | Use | Prediction | Why |
|---|---|---|---|
| `gsap` 3 (160 calls: tweens, `delayedCall`, ticker) | everywhere | **works** | Pure JS, driven by `requestAnimationFrame`. Risk: its CSS-property plugin uses `getComputedStyle` (provided). |
| `seedrandom` | 9 files | **works** | Pure JS. Uses `crypto`/`require` only for auto-seeding. |
| `emoji-regex` | `Whispers.js` | **works** | A large regex with `\u{…}`. Perry's regex engine should take it. |
| `msgpack-lite` + `uuid` + **`WebSocket`** (multiplayer whispers, live leaderboard) | `Server.js` | **works** (as offline) | `VITE_SERVER_URL` is empty by default, so the game stays offline (`is-server-offline`), as a local browser build does. `msgpack-lite` pulls in Node `Buffer` (Vite polyfills it). That may fail to compile; if so, shim it. |
| `localStorage` (23 uses: uuid, options, achievements, circuit best times, …) | many | **works** | Saved to a file. |
| `tweakpane` + plugins, `stats-gl`, `three/addons/inspector` | `Debug.js` (`#debug` only), `Monitoring.js` (commented out), `Rendering.js` (`#inspector`) | **works** (compiles) / unused | It must compile because it's imported statically. It never runs without the hash. |
| `requestAnimationFrame` (8) and the renderer animation loop | `Ticker.js`, gsap | **works** | – |
| Web Workers, WASM directly in game code | none (only inside Draco, KTX2 and Rapier) | – | Covered above. |

## 8. Perry compiler risks

- A 30k-line JS codebase, plus `three.webgpu.js` (~60k lines, heavily class-based, with `Proxy` used by TSL's
  `ShaderNode` for swizzles such as `.xz`, `.rgb`, `.mulAssign`). **TSL relies on `Proxy`, and Perry's Proxy support is "limited".**
  I rate this as the single biggest compile and run risk. If `Proxy` get traps fail, every material construction throws.
- Dynamic `import('@dimforge/rapier3d')`: it's a literal, so it's resolvable. It goes away with the swap anyway.
- Getters and setters on classes, `static` fields, `#private`, spread of arguments: expected fine (A2 compiled three.js 0.187).

## Summary of predictions

| Prediction | Items |
|---|---|
| **works** (level 1) | GLTFLoader, TextureLoader, `Image`, DOM/CSS UI (mostly), keyboard, mouse, wheel, touch, gsap, seedrandom, emoji-regex, uuid, localStorage, rAF, `location.hash`, `Intl`, tweakpane/stats (unused), WebSocket (offline by default), directional light and shadows, data/canvas textures, the `Object3D.copy` override |
| **shim** (level 2) | `three/webgpu` alias, renderer members (backend, sorts, compute, timestamps), `RenderPipeline` stub, render targets swallowed, node-material colour translation, `InstancedMesh` expansion, Draco pre-decode (assets), Stylus precompile, Vite `import.meta.env`, site staging, Howler XHR, local fonts for Google Fonts, `window.open` |
| **swap** (level 3) | **Rapier → Bloom Jolt** (Rapier-API facade, including a raycast vehicle) |
| **rewrite** (level 4) | none planned. The shader-driven systems would each need a rewrite, so they are listed as not portable instead. |
| **✗ not portable** without bridge or engine work | the TSL look (toon shading, fog, light bounce, reveal), vertex-animated foliage/grass/water/snow/rain, GPU compute particles (leaves, rain, snow), render-target effects (tire tracks, noise textures, cube pre-render), post-processing (bloom, DOF), points/lines/sprites, gamepad |

**Expected outcome:** the game becomes drivable natively, with the world's geometry in palette colours under Bloom's own
lighting, the DOM UI, sound and the physics props. It will not look like the original: most of what makes the
portfolio's look is shader code the bridge cannot translate. Physics is the gating item for "playable".
