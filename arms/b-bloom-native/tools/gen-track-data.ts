// Build-time asset extraction (run with `node tools/gen-track-data.ts`).
//
// Why this exists: Bloom's runtime has no binary file read and no API that
// exposes a loaded model's triangles, so the hidden collider meshes inside
// track.glb cannot be turned into Jolt shapes at runtime. This tool reads the
// (read-only) files in ./assets and writes two derived files OUTSIDE ./assets:
//
//   src/generated/trackData.ts       manifest numbers the game needs (typed)
//   resources/track_collision.txt    col_road / col_barriers / col_terrain
//                                     triangles as plain integers (millimetres)
//
// No geometry is invented; this is a lossless (to 1 mm) re-encoding of the
// collider meshes shipped in the asset set.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = (p: string): string => join(root, "assets", p);

interface Gltf {
  nodes: { name?: string; mesh?: number; translation?: number[] }[];
  meshes: { name?: string; primitives: { attributes: Record<string, number>; indices: number }[] }[];
  accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }[];
  bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[];
}

function readGlb(path: string): { json: Gltf; bin: Buffer } {
  const b = readFileSync(path);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString("utf8")) as Gltf;
  const binHeader = 20 + jsonLen;
  const binLen = b.readUInt32LE(binHeader);
  const bin = b.subarray(binHeader + 8, binHeader + 8 + binLen);
  return { json, bin };
}

function readAccessor(g: { json: Gltf; bin: Buffer }, idx: number): number[] {
  const acc = g.json.accessors[idx];
  const view = g.json.bufferViews[acc.bufferView];
  const comps = acc.type === "VEC3" ? 3 : acc.type === "VEC2" ? 2 : acc.type === "VEC4" ? 4 : 1;
  const size = acc.componentType === 5126 || acc.componentType === 5125 ? 4 : acc.componentType === 5123 ? 2 : 1;
  const stride = view.byteStride ?? comps * size;
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const out: number[] = [];
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < comps; c++) {
      const o = base + i * stride + c * size;
      let v: number;
      if (acc.componentType === 5126) v = g.bin.readFloatLE(o);
      else if (acc.componentType === 5125) v = g.bin.readUInt32LE(o);
      else if (acc.componentType === 5123) v = g.bin.readUInt16LE(o);
      else v = g.bin.readUInt8(o);
      out.push(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------- collision
const track = readGlb(A("track/track.glb"));
const colNames = ["col_road", "col_barriers", "col_terrain"];
let colText = "";
for (const name of colNames) {
  const node = track.json.nodes.find((n) => n.name === name);
  if (!node || node.mesh === undefined) throw new Error("missing collider node " + name);
  const prim = track.json.meshes[node.mesh].primitives[0];
  const pos = readAccessor(track, prim.attributes.POSITION);
  const idx = readAccessor(track, prim.indices);
  // Weld duplicate vertices (glTF splits verts by normal) so Jolt gets a
  // connected mesh: fewer verts and no internal-edge ghost collisions.
  const key = new Map<string, number>();
  const verts: number[] = [];
  const remap: number[] = [];
  for (let i = 0; i < pos.length / 3; i++) {
    const x = Math.round(pos[i * 3] * 1000);
    const y = Math.round(pos[i * 3 + 1] * 1000);
    const z = Math.round(pos[i * 3 + 2] * 1000);
    const k = x + "," + y + "," + z;
    let id = key.get(k);
    if (id === undefined) {
      id = verts.length / 3;
      key.set(k, id);
      verts.push(x, y, z);
    }
    remap.push(id);
  }
  const tris: number[] = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = remap[idx[i]], b = remap[idx[i + 1]], c = remap[idx[i + 2]];
    if (a === b || b === c || a === c) continue; // degenerate after weld
    tris.push(a, b, c);
  }
  colText += name + " " + verts.length / 3 + " " + tris.length / 3 + "\n";
  colText += verts.join(" ") + "\n" + tris.join(" ") + "\n";
  console.log(name, "verts", verts.length / 3, "tris", tris.length / 3);
}
mkdirSync(join(root, "resources"), { recursive: true });
writeFileSync(join(root, "resources/track_collision.txt"), colText + "end 0 0\n");

// ---------------------------------------------------------------- manifest
interface Manifest {
  car: { metrics: Record<string, unknown>; variants: { name: string; albedo_texture: string }[] };
  track: {
    length_m: number;
    road_width_m: number;
    spawns: { position: number[]; rotation: number[]; forward: number[] }[];
    checkpoints: { position: number[]; forward: number[]; box_size: number[]; box_center_local: number[]; distance_along_track_m: number }[];
    minimap: { image_size_px: number[]; pixels_per_metre: number; offset_px: number[] };
  };
  environment: {
    sun: { light_direction: number[]; color_linear: number[] };
    ambient: { sky_color_linear: number[] };
    fog: { color_srgb: number[]; suggested_start_m: number; suggested_end_m: number };
  };
}
const m = JSON.parse(readFileSync(A("manifest.json"), "utf8")) as Manifest;
const line = JSON.parse(readFileSync(A("track/racing_line.json"), "utf8")) as { x: number; y: number; z: number; speed_kmh: number }[];
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const arr = (a: number[]): string => "[" + a.map(r3).join(", ") + "]";

let ts = "// GENERATED by tools/gen-track-data.ts from assets/manifest.json and\n";
ts += "// assets/track/racing_line.json. Do not edit by hand.\n\n";
ts += "export const TRACK_LENGTH_M = " + r3(m.track.length_m) + ";\n";
ts += "export const ROAD_WIDTH_M = " + r3(m.track.road_width_m) + ";\n\n";
ts += "// Racing line, flat [x, y, z, speedKmh] per point, closed loop, ~5 m spacing.\n";
ts += "export const RACING_LINE: number[] = [\n";
for (const p of line) ts += "  " + r3(p.x) + ", " + r3(p.y) + ", " + r3(p.z) + ", " + r3(p.speed_kmh) + ",\n";
ts += "];\n\n";
ts += "// Spawns: flat [px, py, pz, qx, qy, qz, qw] (pole first).\n";
ts += "export const SPAWNS: number[] = [\n";
for (const s of m.track.spawns) ts += "  " + [...s.position, ...s.rotation].map(r3).join(", ") + ",\n";
ts += "];\n\n";
ts += "// Checkpoints in race order (cp_00 = start/finish): flat\n";
ts += "// [px, py, pz, fx, fy, fz, sizeAcross, sizeUp, sizeAlong, centerUp, s]\n";
ts += "export const CHECKPOINTS: number[] = [\n";
for (const c of m.track.checkpoints) {
  ts += "  " + [...c.position, ...c.forward, ...c.box_size, c.box_center_local[1], c.distance_along_track_m].map(r3).join(", ") + ",\n";
}
ts += "];\n\n";
const mm = m.track.minimap;
ts += "export const MINIMAP_SIZE_PX = " + mm.image_size_px[0] + ";\n";
ts += "export const MINIMAP_PX_PER_M = " + mm.pixels_per_metre + ";\n";
ts += "export const MINIMAP_OFFSET_PX: number[] = " + arr(mm.offset_px) + ";\n\n";
const env = m.environment;
ts += "export const SUN_LIGHT_DIR: number[] = " + arr(env.sun.light_direction) + ";\n";
ts += "export const SUN_COLOR: number[] = " + arr(env.sun.color_linear) + ";\n";
ts += "export const AMBIENT_SKY: number[] = " + arr(env.ambient.sky_color_linear) + ";\n";
ts += "export const FOG_COLOR_SRGB: number[] = " + arr(env.fog.color_srgb) + ";\n";
ts += "export const FOG_END_M = " + env.fog.suggested_end_m + ";\n\n";
ts += "// Car colour variants (index 0 = player).\n";
ts += "export const CAR_VARIANT_NAMES: string[] = [" + m.car.variants.map((v) => JSON.stringify(v.name)).join(", ") + "];\n";
ts += "export const CAR_VARIANT_TEXTURES: string[] = [" + m.car.variants.map((v) => JSON.stringify("assets/" + v.albedo_texture)).join(", ") + "];\n";
mkdirSync(join(root, "src/generated"), { recursive: true });
writeFileSync(join(root, "src/generated/trackData.ts"), ts);
console.log("racing line points", line.length, "checkpoints", m.track.checkpoints.length);
