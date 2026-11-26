/**
 * Game-specific adapters for folio-2025 on Bloom: what the game computes in shaders that Bloom can't run,
 * replaced by what Bloom can draw (PORT_LOG.md, entries "ground", "lighting", "reveal grid"). Installed by
 * main.ts; they hook into the game once it has built its world, through the game's own ticker.
 *
 *  - ground: the floor is a camera-following plane, displaced and coloured per pixel from the terrain
 *    data texture in its shader. Instead, the static terrain mesh the game loads for physics (terrain.glb)
 *    is drawn with the ground colours baked from that data texture (bake-terrain.mjs).
 *  - lighting: the game shades in its materials from day-cycle uniforms (light colour and intensity,
 *    shadow colour); its DirectionalLight (intensity 5) only casts shadows. Bloom's sun follows the
 *    day-cycle light, and an ambient light tinted by the shadow colour fills the shadows.
 *  - reveal grid: the dark grid floor outside the reveal circle is discarded inside it by its shader;
 *    drawn whole it covers the ground, so it is hidden (the reveal animation itself can't be drawn).
 *  - water surface: white, with its alpha from a shader mask (foam at the shores, clear elsewhere); drawn
 *    opaque it hides the lakes, so it is hidden: the ground's baked colours show the lake beds' blue.
 */
import * as THREE from "three/webgpu";
import { setTonemap, setColorSaturation, setAutoExposure, setManualExposure, setEnvIntensity, Tonemap } from "@bloomengine/engine/core";
import { Game } from "./.build/sources/Game/Game.js";

type AnyGame = Record<string, any>;

const TERRAIN_SIZE = 192;   // Terrain.js: subdivision 128 x 1.5 (its uv = position / 128 / 1.5 + 0.5)

function installGround(game: AnyGame): void {
  const floor = game["world"]?.["floor"];
  if (floor === undefined) return;
  const source = (game["resources"]["terrainModel"].scene.children[0]) as THREE.Mesh;
  source.updateMatrixWorld(true);
  const geometry = (source.geometry as THREE.BufferGeometry).clone();
  geometry.applyMatrix4(source.matrixWorld);
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i) / TERRAIN_SIZE + 0.5; uv[i * 2 + 1] = pos.getZ(i) / TERRAIN_SIZE + 0.5; }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  const map = new THREE.TextureLoader().load("terrain/terrainColor.png");
  map.colorSpace = THREE.SRGBColorSpace;
  const ground = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ map }));
  ground.name = "bloomGround";
  ground.receiveShadow = true;
  game["scene"].add(ground);
  game["ticker"].events.on("tick", () => { floor.mesh.visible = false; }, 997);
}

function installLighting(game: AnyGame): void {
  const lighting = game["lighting"], cycles = game["dayCycles"];
  if (lighting === undefined || cycles === undefined) return;
  const ambient = new THREE.AmbientLight(0xffffff, Number(process.env["FOLIO_AMBIENT"] ?? "") || 0.35);
  const sunScale = Number(process.env["FOLIO_SUN"] ?? "") || 0.5;
  ambient.name = "bloomAmbient";
  game["scene"].add(ambient);
  const white = new THREE.Color(1, 1, 1);
  game["ticker"].events.on("tick", () => {
    const light = lighting.light as THREE.DirectionalLight;
    light.color.copy(lighting.colorUniform.value as THREE.Color);
    // the game's intensities (1.2 by day, 3.8 for the blue night light) on Bloom's scale (about 0.5-0.8)
    light.intensity = Math.min(1, (lighting.intensityUniform.value as number) * sunScale);
    const shadow = cycles.properties?.shadowColor?.value as THREE.Color | undefined;
    if (shadow !== undefined) ambient.color.copy(shadow).lerp(white, 0.5);
  }, 997);
}

function installRevealGrid(game: AnyGame): void {
  const world = game["world"];
  game["ticker"].events.on("tick", () => {
    if (world?.["grid"]?.mesh) world["grid"].mesh.visible = false;
    if (world?.["waterSurface"]?.mesh) world["waterSurface"].mesh.visible = false;
  }, 997);
}

/**
 * The look: the game outputs its shaded palette colours directly (no tonemapping, no image-based
 * lighting), Bloom tonemaps a lit HDR image. Bloom's knobs, set to come close (FOLIO_* override them).
 */
function installLook(): void {
  const env = process.env as Record<string, string | undefined>;
  const num = (k: string, d: number): number => { const v = Number(env[k] ?? ""); return env[k] !== undefined && isFinite(v) ? v : d; };
  setTonemap(env["FOLIO_TONEMAP"] === "aces" ? Tonemap.ACES : Tonemap.AgX);
  setColorSaturation(num("FOLIO_SATURATION", 1));
  setEnvIntensity(num("FOLIO_ENV", 1));
  const exposure = num("FOLIO_EXPOSURE", 0);
  if (exposure > 0) { setAutoExposure(false); setManualExposure(exposure); }
}

// wait for the game to build its world (Game.init is async: resources, then the world)
const raf = (globalThis as unknown as { requestAnimationFrame(f: () => void): void }).requestAnimationFrame;
const pending = { ground: true, lighting: true, grid: true };
function poll(): void {
  const game = (Game as unknown as { getInstance(): AnyGame | undefined }).getInstance();
  if (game !== undefined && game["ticker"] !== undefined) {
    if (pending.lighting && game["lighting"] !== undefined) { installLighting(game); pending.lighting = false; }
    if (pending.grid && game["world"]?.["grid"] !== undefined) { installRevealGrid(game); pending.grid = false; }
    if (pending.ground && game["world"]?.["floor"] !== undefined && game["resources"]?.["terrainModel"] !== undefined) { installGround(game); pending.ground = false; }
  }
  if (pending.ground || pending.lighting || pending.grid) installLook();
raf(poll);
}
installLook();
raf(poll);
