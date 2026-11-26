# Step 0: three.js's real WebGPURenderer under Perry

The question: can unmodified three.js (r187, `three/webgpu` + `three/tsl`) run its own `WebGPURenderer`
when compiled by Perry, so that Bloom only has to provide `navigator.gpu` (WebGPU on wgpu) instead of
re-implementing three.js's renderer?

`main.js` builds a scene with a TSL node material (`Fn`, `uniform`, swizzles, an animated vertex
`positionNode`), a classic material with a data texture, shadows, an `InstancedMesh`, GPU compute particles
drawn as sprites (`instancedArray` + `.compute()`), `Points`, a `Line`, an offscreen `RenderTarget`, and
post-processing (`RenderPipeline` + `pass()` + `bloom()`). It renders through `setAnimationLoop` against
`fakegpu.js`, a WebGPU implementation that answers every call and records it (no Proxy or Reflect, so the
harness doesn't depend on what's being tested). The same file runs under Node (the reference) and as a Perry
binary, and the outputs are diffed.

```sh
npm install
node main.js node [frames]                     # reference run; writes out/
P=~/projects/perry/worktrees/perry-main-latest  # Perry main 1095f50fc5 (0.5.1664 can't compile three 0.187, see A2 PORT_LOG #1)
PERRY_RUNTIME_DIR=$P/target/release $P/target/release/perry compile main.js -o dist/spike   # ~4 min
./dist/spike perry [frames]
diff -r out/wgsl-node out/wgsl-perry; diff out/writes-node.txt out/writes-perry.txt
```

## Results

| Check | Result |
|---|---|
| Perry compiles `three.webgpu.js` + `three.tsl.js` + `three.core.js` (~90k lines) | yes, 0 errors, ~3.8 min, 54 MB binary |
| TSL (relies on `Proxy` for swizzles such as `.xz`) runs under Perry | **yes** |
| WebGPU call stream, Perry vs Node | **identical** in every phase (init, compute, 4 frames): same calls, same counts |
| Uploaded data (`writeBuffer` contents) | **identical**, except the `time` uniform (harness can't freeze Perry's clock, bug 3) |
| Generated WGSL | 27 modules (9 vertex, 16 fragment, 2 compute). Under Node all 27 are valid for **naga 29** (Bloom's wgpu version) and translate to MSL. Under Perry 7 contain wrong constants (bugs 1, 2) |
| WebGPU surface used | ~55 distinct methods; steady state **~265 calls/frame** and 480 bytes of uniform uploads for this scene (64 draws incl. shadow, render-target and bloom passes) |
| CPU per frame for three.js's renderer (fake GPU, no GPU work) | Node **1.2–1.8 ms**; Perry **7–37 ms** (5–20×; the factor swings with machine load, which was 120–220 on 10 cores; re-measure on an idle machine) |
| Shader build cost (new `MeshPhysicalNodeMaterial`) | Node 86 ms, Perry 232 ms |

### Perry bugs found (minimal repros in `repro/`, checked on main 1095f50fc5)

1. **`new ImportedClass(...args)` passes the array as the first argument** (`repro/spread-imported/`). Same-module
   classes are fine. In three.js this hits every TSL constant built by `getValueFromType`
   (`new Vector3(...params)`, `new Color(...params)`): `vec3(0.04)` becomes `vec3(NaN, 0, 0)`.
2. **`.includes()` returns false on a variable declared `null` and later assigned a string**
   (`repro/includes-after-null.js`). In three.js's `LoopNode` this flips `i++` to `i--`, giving infinite GPU loops in
   the bloom blur shaders.
3. **`performance.now` can't be replaced** (`repro/performance-now.js`). Minor; matters for test harnesses and polyfills.

### Where Perry's time goes (macOS `sample`, symbols build)

| Share | Bucket |
|---:|---|
| 38.7 % | runtime property get/set and method dispatch (`layout_probe::inherited_get`, `indexed::get`, `perry_probe_*`, `try_data_lookup_key`, `class_instance_inherited_read`, key lookups) |
| 36.6 % | compiled three.js code itself (`Renderer._renderScene`, `NodeManager.updateForRender`, `Matrix4.*`, ...) |
| 8.7 % | Map / WeakMap / arrays / strings |
| 2.9 % | memory / GC |
| 13.2 % | other |

Raw profile: `out/sample.txt`. Also noticed: keeping a growing array of strings (the harness's call log) made
Perry's frame time climb from ~10 to ~50 ms over 3,000 frames, while Node stayed flat.

This program is a ready-made benchmark for Perry performance work: real three.js, a realistic frame, a
deterministic Node reference, and no GPU needed.

## Retest with the fixes (Perry origin/main 8cd28d4cf0, 2026-11-09 19:00)

Built in `~/projects/perry/worktrees/perry-racer-retest` (`cargo build --release -p perry -p perry-runtime-static
-p perry-stdlib-static -p perry-ext-net -p perry-ext-ws` with `LLVM_SYS_221_PREFIX=/opt/homebrew/opt/llvm@22`, then
`scripts/gc_call_effects/sidecars.sh target/release`). Binary: `dist/spike-new`.

| Check | Result |
|---|---|
| 3 repros | all print the same as Node (fixed by 68ffc4d7a5 and 8cd28d4cf0) |
| WGSL | **byte-identical** to Node: 29 modules, same hash; all 29 valid in naga 29 and translate to Metal |
| Uploaded data | **identical** to Node in every phase, including the `time` uniform |
| CPU per frame (1000 frames, 5 rounds, load ~40–50) | Node **0.33–0.37 ms**; old Perry 3.7–4.8 ms; new Perry **3.4–5.0 ms**: unchanged, about **10–12× Node** |
| Shader build (new physical material) | Node 23 ms, new Perry 166 ms |

Correctness is solved; speed is unchanged. The profile above (runtime property get/set and dispatch ~39 %) is
still the place to look.

## Why Perry is slow on three.js (new Perry 8cd28d4cf0)

Tools: `tools/categorize.py` (groups runtime self time under JS frames by mechanism) and `tools/attribute.py`
(charges runtime self time to the calling JS function), both reading a macOS `sample` call tree
(`out/sample-new.txt`, 6000-frame run of `dist/spike-new-sym`). Micro-benchmarks in `patterns/`
(`node patterns.js node` vs the Perry build of the same file).

### 1. Where a frame's CPU time goes

| Share | |
|---:|---|
| 34.9 % | compiled three.js code itself |
| 15.7 % | generic property reads (shape probes: `perry_probe_get`, `layout_probe::indexed::get`, `keys_find_slot_by_bytes`, ...) |
| 10.2 % | lookups that walk the prototype chain (`layout_probe::inherited::inherited_get`, `get_prototype_of`) |
| 8.1 % | field writes and the GC write barrier (`perry_probe_set`, `js_put_value_set`, `barrier_store`) |
| 4.3 % | strings (to_string, utf8 conversion, concat, memcmp: three's cache keys) |
| 3.6 % | method call dispatch |
| 3.3 % | arrays |
| 2.9 % | getter/setter dispatch |
| 2.3 % | thread-local storage access (`_tlv_get_addr`, a function call on macOS) on hot paths |
| 1.9 % | GC / allocation |
| 1.8 % | for...in / key enumeration |
| 1.2 % | Map / WeakMap / Set |
| ~10 % | other runtime |

About 5 % of the samples are the fake GPU itself (`makePass`/`makeEncoder` build objects with closures per
frame); a native `navigator.gpu` wouldn't have that cost.

Two layers: ~62 % is runtime slow paths (fixable one mechanism at a time), and the ~35 % compiled code alone
(≈1.2 ms) is already ~3–4× Node's *whole* frame (≈0.35 ms), so code generation for untyped JS is a second,
separate gap (dynamic arithmetic on values of unknown type, every property access a runtime call).

### 2. Patterns, Perry vs Node (ns per operation; `patterns/patterns.js`)

| Pattern | Node | Perry | × |
|---|---:|---:|---:|
| missing property on a 6-level class (`mesh.isPoints`) | 0.7 | **39.8** | 60 |
| `for...in` over 8 keys | 16 | **884** | 55 |
| missing property (`=== undefined`) on a 3-level class | 0.7 | 28.4 | 39 |
| `Object.getOwnPropertyNames(instance)` | 11 | 390 | 36 |
| add a property to an existing class instance | 8 | 222 | 27 |
| missing property on a 1-level class | 0.7 | 18.3 | 26 |
| `instanceof` across 3 levels | 3.7 | 93 | 25 |
| missing property on a plain object | 0.7 | 11.9 | 17 |
| inherited getter | 0.8 | 10.2 | 13 |
| `super.method()` chain | 0.8 | 8.7 | 11 |
| `Object.keys` (8 keys) | 12 | 91 | 7.5 |
| own field read / method call / closure call (the baseline) | 0.7–0.9 | ~4.2 | 4.5–6 |
| `obj[key]` on a class instance | 9 | 52 | 5.7 |
| Map/WeakMap/Set lookups | 4.5–6 | 17–22 | 3.5–4 |
| allocation, typed arrays, `Math.imul`, number→string, polymorphic calls | — | — | ≤1 (as fast or faster) |

Findings:
- **No negative cache for missing properties:** the cost grows with prototype-chain depth (12 → 18 → 40 ns for
  0, 1 and 6 levels). three.js type-checks by duck typing everywhere (`if (object.isPoints) … else if
  (object.isLine) …` in `WebGPUUtils.getPrimitiveTopology`; `isNode`, `isTexture`, `isMaterial`, ...), on
  hierarchies 3–6 classes deep.
- **Inherited methods are cached** (4.4 ns whether 2 or 5 levels up); only *misses* walk the chain.
- **Writes that need a prototype check walk the chain too** (`js_put_value_set` → `inherited_get`, most of it in
  `Renderer._renderScene`).
- **Reflection is very slow:** `for...in` (`NodeMaterialObserver.equals` loops over every tracked material
  uniform per object per frame, then reads `material[property]`; `RenderObject.needsGeometryUpdate` iterates
  attributes), `Object.getOwnPropertyNames` + `this[property]` (`Node._getChildren`, used by cache keys).
- **No polymorphic-cache cliff** (`patterns/ic.js`: 8 shapes at one site stay at 2 ns; Node degrades after 4).
- **Open: some plain field writes cost ~10.5 ns instead of ~2 ns depending on program context**, reproducible
  (`patterns/bisect.js`: `F1`/`F2` slow every run, structurally identical `L0`–`L4` fast; `patterns/leaf-write.js`).
  In isolation (`patterns/slowwrite.js`) the same write is inlined and fast, so it's a code-generation decision,
  not the object layout.

### 3. Suggested order of work (largest share × clearest fix)
1. Negative/miss caching for property reads (and the prototype check on writes): ~10 % of the frame, 17–60× per op.
2. Make the monomorphic own-field read/write/method-call path inline instead of a runtime call: the 4–6× baseline
   under ~25 % of the frame.
3. Take thread-local access off the hot paths (2.3 %).
4. `for...in`, `Object.keys`, `getOwnPropertyNames`: 7–55× per op; small share here, but common in other code.
5. `instanceof`, inherited getters, `super` calls (10–25×).
6. The context-dependent slow write (open item above).

## What it means

- The approach holds: unmodified three.js generates a standard, small, deterministic WebGPU call stream, and
  naga accepts its shaders. Bloom implementing `navigator.gpu` on its wgpu device is a bounded job, not a
  re-implementation of three.js.
- The blockers are in Perry, not in three.js or WebGPU: two correctness bugs that corrupt shaders, and CPU speed
  of dynamic property access (three.js's per-frame scene, material and node bookkeeping).

Next (Step 1): a minimal `navigator.gpu` on Bloom's device, rendering this scene to a window and comparing it
with Chrome.
