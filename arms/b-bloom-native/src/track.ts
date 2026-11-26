// Track: visuals (scene nodes), static collision (Jolt meshes), racing line
// and checkpoint data.
import { readFile } from "bloom/core";
import { loadModel } from "bloom/models";
import { createSceneNode, attachModelToNode, setSceneNodeTransform } from "bloom/scene";
import * as physics from "bloom/physics";
import { dataPath } from "./paths";
import { RACING_LINE, CHECKPOINTS, SPAWNS } from "./generated/trackData";

// Primitive indices of track.glb inside Bloom's model (glTF mesh order, then
// node placement, then primitive). 0..17 are visual; 18..20 are colliders
// (col_road, col_barriers, col_terrain) and are never attached for rendering.
const VISUAL_PRIMITIVES = 18;

export interface TrackBodies { road: number; barriers: number; terrain: number }

export function loadTrackVisuals(): void {
  const model = loadModel("assets/track/track.glb");
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const n = Math.min(VISUAL_PRIMITIVES, model.meshCount);
  for (let i = 0; i < n; i++) {
    const node = createSceneNode();
    attachModelToNode(node, model.handle, i);
    setSceneNodeTransform(node, identity);
  }
}

// --- tiny integer tokenizer (avoids split/parseFloat, Perry quirk #5) ---
let tokText = "";
let tokPos = 0;
function nextWord(): string {
  const len = tokText.length;
  while (tokPos < len && tokText.charCodeAt(tokPos) <= 32) tokPos++;
  const start = tokPos;
  while (tokPos < len && tokText.charCodeAt(tokPos) > 32) tokPos++;
  return tokText.substring(start, tokPos);
}
function nextInt(): number {
  const len = tokText.length;
  while (tokPos < len && tokText.charCodeAt(tokPos) <= 32) tokPos++;
  let neg = false;
  if (tokText.charCodeAt(tokPos) === 45) { neg = true; tokPos++; }
  let v = 0;
  while (tokPos < len) {
    const c = tokText.charCodeAt(tokPos);
    if (c < 48 || c > 57) break;
    v = v * 10 + (c - 48);
    tokPos++;
  }
  if (neg) return -v;
  return v;
}

export function loadTrackCollision(world: number): TrackBodies {
  tokText = readFile(dataPath("track_collision.txt"));
  tokPos = 0;
  const out: TrackBodies = { road: 0, barriers: 0, terrain: 0 };
  if (tokText.length === 0) {
    console.log("ERROR: track_collision.txt missing - run `node tools/gen-track-data.ts`");
    return out;
  }
  for (let guard = 0; guard < 8; guard++) {
    const name = nextWord();
    const nv = nextInt();
    const nt = nextInt();
    if (name === "end" || name.length === 0) break;
    const verts: physics.Vec3[] = new Array(nv);
    for (let i = 0; i < nv; i++) {
      const x = nextInt() * 0.001;
      const y = nextInt() * 0.001;
      const z = nextInt() * 0.001;
      verts[i] = { x: x, y: y, z: z };
    }
    const idx: number[] = new Array(nt * 3);
    for (let i = 0; i < nt * 3; i++) idx[i] = nextInt();
    const shape = physics.meshShape(verts, idx);
    let friction = 1.0;
    if (name === "col_barriers") friction = 0.25;
    if (name === "col_terrain") friction = 0.55;
    const body = physics.createBody(world, shape, {
      motionType: physics.MotionType.STATIC,
      objectLayer: physics.Layer.NON_MOVING,
      friction: friction,
      restitution: 0.1,
    });
    if (name === "col_road") out.road = body;
    else if (name === "col_barriers") out.barriers = body;
    else if (name === "col_terrain") out.terrain = body;
    console.log("collision " + name + " verts=" + nv + " tris=" + nt + " body=" + body);
  }
  tokText = "";
  return out;
}

// ------------------------------------------------------------ racing line
export const LINE_N = Math.floor(RACING_LINE.length / 4);
export const lineX: number[] = new Array(LINE_N);
export const lineY: number[] = new Array(LINE_N);
export const lineZ: number[] = new Array(LINE_N);
export const lineSpeed: number[] = new Array(LINE_N); // m/s
export const lineS: number[] = new Array(LINE_N);     // cumulative distance
export let lineLength = 0;

export function initRacingLine(): void {
  let s = 0;
  for (let i = 0; i < LINE_N; i++) {
    lineX[i] = RACING_LINE[i * 4];
    lineY[i] = RACING_LINE[i * 4 + 1];
    lineZ[i] = RACING_LINE[i * 4 + 2];
    lineSpeed[i] = RACING_LINE[i * 4 + 3] / 3.6;
    if (i > 0) {
      const dx = lineX[i] - lineX[i - 1];
      const dz = lineZ[i] - lineZ[i - 1];
      s += Math.sqrt(dx * dx + dz * dz);
    }
    lineS[i] = s;
  }
  const dx = lineX[0] - lineX[LINE_N - 1];
  const dz = lineZ[0] - lineZ[LINE_N - 1];
  lineLength = s + Math.sqrt(dx * dx + dz * dz);
}

export function wrapIndex(i: number): number {
  let r = i % LINE_N;
  if (r < 0) r += LINE_N;
  return r;
}

/** Nearest racing-line index; searches ±window around hint (full scan if hint < 0). */
export function nearestLineIndex(x: number, z: number, hint: number, window: number): number {
  let best = 0;
  let bestD = 1e18;
  if (hint < 0) {
    for (let i = 0; i < LINE_N; i++) {
      const dx = lineX[i] - x, dz = lineZ[i] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  for (let k = -window; k <= window; k++) {
    const i = wrapIndex(hint + k);
    const dx = lineX[i] - x, dz = lineZ[i] - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ------------------------------------------------------------ checkpoints
export const NUM_CP = Math.floor(CHECKPOINTS.length / 11);
export function cpX(i: number): number { return CHECKPOINTS[i * 11]; }
export function cpY(i: number): number { return CHECKPOINTS[i * 11 + 1]; }
export function cpZ(i: number): number { return CHECKPOINTS[i * 11 + 2]; }
export function cpFX(i: number): number { return CHECKPOINTS[i * 11 + 3]; }
export function cpFZ(i: number): number { return CHECKPOINTS[i * 11 + 5]; }
export function cpHalfWidth(i: number): number { return CHECKPOINTS[i * 11 + 6] * 0.5; }
export function cpHeight(i: number): number { return CHECKPOINTS[i * 11 + 7]; }

/** Signed distance of (x,z) along checkpoint i's forward axis. */
export function cpAlong(i: number, x: number, z: number): number {
  return (x - cpX(i)) * cpFX(i) + (z - cpZ(i)) * cpFZ(i);
}
/** Signed lateral distance of (x,z) from checkpoint i's centre (right = +). */
export function cpAcross(i: number, x: number, z: number): number {
  // right vector for forward f in XZ with +Y up: (-fz, fx) rotated → (−f.z, f.x)? use f × up
  return (x - cpX(i)) * (-cpFZ(i)) + (z - cpZ(i)) * cpFX(i);
}

export function spawnPos(i: number): physics.Vec3 {
  return { x: SPAWNS[i * 7], y: SPAWNS[i * 7 + 1], z: SPAWNS[i * 7 + 2] };
}
export function spawnRot(i: number): physics.Quat {
  return { x: SPAWNS[i * 7 + 3], y: SPAWNS[i * 7 + 4], z: SPAWNS[i * 7 + 5], w: SPAWNS[i * 7 + 6] };
}
