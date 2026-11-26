# Bevy friction log

Pinned: **Bevy 0.20.1**, avian3d 0.8.0 (see `NOTES.md`). Entries are in the order they happened.
Each entry: what I expected → what was true → how I found out → cost.

## 1. Scenes renamed: `SceneRoot` / `SceneInstanceReady` → `WorldAssetRoot` / `WorldInstanceReady`
- **Expected:** `commands.spawn(SceneRoot(asset_server.load(GltfAssetLabel::Scene(0).from_asset(..))))` and an
  observer on `SceneInstanceReady` (the 0.15–0.17 API I know).
- **True:** 0.20 moved glTF scene spawning to `bevy_world_serialization`: the component is `WorldAssetRoot(Handle<WorldAsset>)`,
  the ready event `bevy::world_serialization::WorldInstanceReady { entity, instance_id }`. `bevy_scene` now means the new
  BSN (`bsn_list!`) scene system used by the `3d_scene` example.
- **How found:** read `examples/gltf/load_gltf.rs` + `edit_material_on_gltf.rs` at tag `v0.20.1` before writing code.
- **Cost:** ~10 min of reading; zero compile iterations (caught before writing).

## 2. `Interaction` component is gone; buttons are `ui_widgets::Button` + `Activate`
- **Expected:** `Button` + `Interaction::Pressed` polling.
- **True:** `bevy::ui_widgets::Button` is headless; it inserts `bevy::ui::Pressed` while held, hover comes from
  `bevy::picking::hover::Hovered`, and a click fires the `Activate` entity event (observe it, e.g. with `ui_widgets::observe`).
  `grep "enum Interaction"` finds nothing in `bevy_ui` 0.20.
- **How found:** grep in `~/.cargo/registry/src/*/bevy_ui-0.20.1`, then `examples/ui/widgets/button.rs`.
- **Cost:** ~10 min.

## 3. Text sizes are `FontSize::Px(..)`, fonts are `font: handle.into()`
- **Expected:** `TextFont { font: handle, font_size: 30.0 }`.
- **True:** `font_size: FontSize::Px(30.0)` (also `Vh`, ...), `font` takes a font *source* (`handle.into()`).
- **How found:** examples (`mobile/src/lib.rs`, `ui/text/text.rs`).
- **Cost:** a couple of minutes.

## 4. glTF: no `KHR_node_visibility`, no `KHR_materials_variants`
- **Expected:** at least node visibility to be respected (the asset README says engines *may* ignore it).
- **True:** neither extension appears in `bevy_gltf-0.20.1`. Collider nodes would be drawn with the invisible material
  (3 wasted draw calls), and colour variants must be done by hand.
- **Workaround:** hide the `col_*` / `collider_body` nodes by `Name` after `WorldInstanceReady`; clone the
  `car_paint_red` material per car and swap `base_color_texture` to `textures/car_body_<colour>_albedo.png`
  (as the asset README suggests).
- **How found:** `grep -rn "visibility\|variants" bevy_gltf-0.20.1/src`.
- **Cost:** ~15 min including the workaround.

## 5. `Gltf::materials` holds `Handle<GltfMaterial>`, not `Handle<StandardMaterial>`
- **Expected:** `gltf.named_materials["car_paint_blue"]` usable as a `StandardMaterial`.
- **True:** 0.20 introduced a `GltfMaterial` asset type; the scene entities still carry `MeshMaterial3d<StandardMaterial>`
  plus a `GltfMaterialName` component, which is what I used instead.
- **How found:** reading `bevy_gltf-0.20.1/src/assets.rs`.
- **Cost:** ~5 min.

## 6. No equirectangular skybox
- **Expected:** a way to use `sky_equirect_2048x1024.png` as `Skybox`.
- **True:** `Skybox` needs a cubemap image; there is no equirect → cubemap helper.
- **Workaround:** a generated UV sphere with the README's exact UV mapping (`track::sky_dome_mesh`), unlit, no fog,
  following the camera. Seam-free because longitude runs −π..π so `u` is monotonic.
- **Cost:** ~10 min.

## 7. Asset root inside a macOS `.app`
- **Expected:** Bevy to find `Contents/Resources/assets` in an app bundle.
- **True:** `FileAssetReader` uses `BEVY_ASSET_ROOT`, then `CARGO_MANIFEST_DIR`, then the executable's directory
  (`Contents/MacOS`). iOS bundles are flat so it works there.
- **Workaround:** `asset_dir()` in `lib.rs` sets `AssetPlugin::file_path = "../Resources/assets"` when running from a bundle.
- **How found:** `bevy_asset-0.20.1/src/io/file/mod.rs::get_base_path`.
- **Cost:** ~5 min.

## 8. Run-condition combinator `.or(..)` renamed to `.or_else(..)`
- **Expected:** `.run_if(in_state(A).or(in_state(B)))`.
- **True:** `no method named 'or'`; 0.20's `SystemCondition` has `or_else` (and `and_then`, ...).
- **How found:** compiler error, then `grep "fn or" bevy_ecs-0.20.1/src/schedule/condition.rs`.
- **Cost:** 1 compile iteration (~3 min incl. rebuild).

## 9. B0001 query-conflict panic hides every name without the `debug` feature
- **Expected:** the classic message naming the system and the conflicting component.
- **True:** `error[B0001]: <Enable the debug feature to see the name> in system <Enable the debug feature to see the name>
  accesses component(s) <Enable the debug feature to see the name> ...`. Release-style builds of 0.20 strip type names.
- **How found:** runtime panic at startup; re-ran with `RUST_BACKTRACE=1` and read the `QueryState<...>` type in the
  backtrace to find the system.
- **Cost:** 2 runs, ~10 min. Enabling `bevy/debug` in dev would have shown it directly.

## 10. avian `Forces` QueryData conflicts with any other `LinearVelocity` reader
- **Expected:** `Query<(.., Forces)>` plus a second read-only `Query<&LinearVelocity, With<Car>>` (for slipstream checks) in the same system.
- **True:** `Forces` holds `Write<LinearVelocity>`/`Write<AngularVelocity>`, so the second query conflicts (B0001 at runtime, not compile time).
- **Workaround:** snapshot positions/velocities with `cars.iter()` (read-only `ForcesReadOnly` items) before the mutable loop.
- **How found:** backtrace (entry 9). **Cost:** 1 iteration.

## 11. `SpatialQuery` + `&mut Position` in the same system conflicts
- **Expected:** a ray-cast + teleport system with `SpatialQuery` and `Query<&mut Position, With<Car>>`.
- **True:** `SpatialQuery` contains `Query<(&Position, &Rotation, &Collider)>`. Runtime B0001.
- **Workaround:** the car bodies have their `Collider` on a child entity, so `Without<Collider>` on my query makes the
  two provably disjoint. (Otherwise a `ParamSet` would be needed.)
- **How found:** backtrace + reading `avian3d/src/spatial_query/system_param.rs`. **Cost:** ~10 min.

## 12. Assets resolve next to the binary when not launched by cargo
- **Expected:** running `./target/debug/racer` from the repo root to find `./assets`.
- **True:** without `CARGO_MANIFEST_DIR` Bevy uses the executable's directory (`target/debug/assets`). Not a bug, but
  surprising for test scripts.
- **Workaround:** `BEVY_ASSET_ROOT=$PWD` in the test runner (`cargo run` sets `CARGO_MANIFEST_DIR` itself).
- **Cost:** 1 run.

## 13. Occluded window on macOS = black screenshots and a stalled loop
- **Expected:** `Screenshot::primary_window()` to work while the window is behind others or the display is asleep.
- **True:** once the display slept/locked, every capture was fully black (even scenarios that captured fine minutes
  earlier), and once the whole app appeared frozen until the window was visible again (presentation blocks).
- **How found:** mean-luminance check of the PNGs (= 0) and comparing with an earlier good run of the same binary.
- **Cost:** ~15 min. An offscreen render target for automated captures would avoid it.

## 14. Build times dominate iteration
- Cold debug build of Bevy 0.20 + avian: ~16.5 min on an M1 Max while another Rust build was running; cold release
  ~13.5 min; each new target (iOS sim, iOS device) is another full Bevy build. Incremental game-code rebuilds are fast
  (see NOTES.md). Not an API issue, but it shaped the workflow: I wrote most modules before the first successful
  compile and used env-var test modes instead of interactive play.

## Top 5 improvements that would have helped most

1. **A per-release "renamed/removed" table in the docs** (`SceneRoot` → `WorldAssetRoot`, `Interaction` → `ui_widgets`,
   `.or` → `.or_else`, `FontSize::Px`). The migration guides exist, but you only find them if you already know what
   you're looking for. A searchable "old name → new name" index on docs.rs (e.g. `#[doc(alias)]` on the new items)
   would turn each of these into a 10-second lookup.
2. **Readable B0001 without the `debug` feature**, or at least `"enable the 'debug' cargo feature of bevy"` spelled
   out as the fix. Better still, a static check (or a lint) when two queries in one system obviously overlap.
3. **Document the access sets of third-party `SystemParam`/`QueryData` types** (avian's `SpatialQuery`, `Forces`) in
   their rustdoc: "conflicts with mutable `Position`/`Rotation`/`LinearVelocity` access in the same system".
4. **An equirectangular → cubemap helper** (or `Skybox` accepting equirect images). Many asset packs ship equirect skies.
5. **glTF `KHR_node_visibility` and `KHR_materials_variants` support** (or a documented hook): both are common in
   game-ready assets and currently need hand-written post-processing after `WorldInstanceReady`.
