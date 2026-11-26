/**
 * Track data from the manifest: racing line, checkpoints, spawns, minimap transform.
 * Pure data + math, no rendering and no physics.
 */
import { readFileSync } from "node:fs";
import { asset } from "./paths.ts";

export interface V3 { x: number; y: number; z: number }
export interface Quat4 { x: number; y: number; z: number; w: number }

export interface LinePoint { x: number; y: number; z: number; speed: number /* m/s */; s: number /* metres along */ }

export interface Checkpoint {
  index: number;
  pos: V3;
  /** race direction (unit, horizontal) */
  fwd: V3;
  /** right vector across the track */
  right: V3;
  halfAcross: number;
  height: number;
  rot: Quat4;
}

export interface Spawn { pos: V3; rot: Quat4; fwd: V3 }

interface ManifestCheckpoint {
  index: number; position: number[]; rotation: number[]; forward: number[]; box_size: number[];
}
interface ManifestSpawn { position: number[]; rotation: number[]; forward: number[] }

export interface Manifest {
  car: {
    metrics: { wheel_radius_m: number; wheel_width_m: number; track_width_m: number; wheelbase_m: number; centre_of_mass_offset_m: number[] };
    variants: { name: string; albedo_texture: string; paint_color_srgb: number[] }[];
    materials: { brake_light: { emissive_off: number[]; emissive_on: number[]; emissive_strength_on: number } };
  };
  track: {
    length_m: number; road_width_m: number;
    spawns: ManifestSpawn[];
    checkpoints: ManifestCheckpoint[];
    minimap: { file: string; image_size_px: number[]; pixels_per_metre: number; offset_px: number[] };
  };
  environment: {
    sun: { direction: number[]; color_linear: number[]; suggested_intensity_relative: number };
    ambient: { sky_color_linear: number[]; ground_color_linear: number[]; suggested_intensity_relative: number };
    fog: { color_srgb: number[]; suggested_start_m: number; suggested_end_m: number };
  };
}

function v3(a: number[]): V3 { return { x: a[0] ?? 0, y: a[1] ?? 0, z: a[2] ?? 0 }; }
function q4(a: number[]): Quat4 { return { x: a[0] ?? 0, y: a[1] ?? 0, z: a[2] ?? 0, w: a[3] ?? 1 }; }

export class Track {
  readonly manifest: Manifest;
  readonly line: LinePoint[] = [];
  readonly length: number;
  readonly checkpoints: Checkpoint[] = [];
  readonly spawns: Spawn[] = [];
  readonly roadHalfWidth: number;

  constructor() {
    this.manifest = JSON.parse(readFileSync(asset("manifest.json"), "utf8")) as Manifest;
    const raw = JSON.parse(readFileSync(asset("track/racing_line.json"), "utf8")) as { x: number; y: number; z: number; speed_kmh: number }[];
    let s = 0;
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i]!;
      if (i > 0) { const q = raw[i - 1]!; s += Math.hypot(p.x - q.x, p.z - q.z); }
      this.line.push({ x: p.x, y: p.y, z: p.z, speed: p.speed_kmh / 3.6, s });
    }
    const first = raw[0]!, last = raw[raw.length - 1]!;
    this.length = s + Math.hypot(first.x - last.x, first.z - last.z);
    const t = this.manifest.track;
    this.roadHalfWidth = t.road_width_m / 2;
    for (const c of t.checkpoints) {
      const fwd = v3(c.forward);
      this.checkpoints.push({
        index: c.index, pos: v3(c.position), fwd,
        // right of the race direction, seen from above (+Y up): fwd x up
        right: { x: -fwd.z, y: 0, z: fwd.x },
        halfAcross: (c.box_size[0] ?? 28) / 2, height: c.box_size[1] ?? 8, rot: q4(c.rotation),
      });
    }
    for (const sp of t.spawns) this.spawns.push({ pos: v3(sp.position), rot: q4(sp.rotation), fwd: v3(sp.forward) });
  }

  point(i: number): LinePoint {
    const n = this.line.length;
    return this.line[((i % n) + n) % n]!;
  }

  /**
   * Nearest racing-line index to (x, z), searching around `hint` first (cheap, per frame)
   * and falling back to a full scan when the hint is far off (after a reset).
   */
  nearest(x: number, z: number, hint: number): number {
    const n = this.line.length;
    let best = -1, bestD = Infinity;
    for (let k = -12; k <= 24; k++) {
      const i = (((hint + k) % n) + n) % n;
      const p = this.line[i]!;
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (bestD > 30 * 30) {
      for (let i = 0; i < n; i++) {
        const p = this.line[i]!;
        const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    return best;
  }

  /** Distance along the line (0..length) of a world point near index i, interpolated on the segment. */
  distanceAt(i: number, x: number, z: number): number {
    const a = this.point(i), b = this.point(i + 1);
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
    if (t < -0.5) t = -0.5; if (t > 1.5) t = 1.5;
    let s = a.s + t * Math.sqrt(len2);
    if (s < 0) s += this.length;
    if (s >= this.length) s -= this.length;
    return s;
  }

  /** Signed lateral offset from the line at index i (+ = right of the race direction). */
  lateral(i: number, x: number, z: number): number {
    const a = this.point(i), b = this.point(i + 1);
    let fx = b.x - a.x, fz = b.z - a.z;
    const l = Math.hypot(fx, fz) || 1; fx /= l; fz /= l;
    return (x - a.x) * -fz + (z - a.z) * fx;
  }

  /** Unit race direction at index i. */
  direction(i: number): V3 {
    const a = this.point(i - 1), b = this.point(i + 1);
    const dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, y: 0, z: dz / l };
  }

  /** Minimap pixel position (in the 1024² image) of a world point. */
  toMap(x: number, z: number): { u: number; v: number } {
    const m = this.manifest.track.minimap;
    return { u: x * m.pixels_per_metre + (m.offset_px[0] ?? 0), v: z * m.pixels_per_metre + (m.offset_px[1] ?? 0) };
  }
}
