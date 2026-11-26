import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { CheckpointDef, Manifest, RacingLinePoint, SpawnDef } from '../core/manifest';
import { KMH } from '../core/config';
import { WallGrid } from './WallGrid';

export type Surface = 'road' | 'offroad' | 'none';

export interface GroundHit {
  y: number;
  nx: number;
  ny: number;
  nz: number;
  surface: Surface;
}

export interface Projection {
  index: number;
  s: number;
  lateral: number; // signed distance from racing line, + = left of race direction
  dist: number;
}

export interface Checkpoint {
  index: number;
  name: string;
  position: THREE.Vector3;
  forward: THREE.Vector3;
  yaw: number;
  halfAcross: number;
  height: number;
  inv: THREE.Matrix4;
  /** distance along the racing line */
  s: number;
}

export interface Spawn {
  position: THREE.Vector3;
  yaw: number;
}

const _ray = new THREE.Ray();
const _v = new THREE.Vector3();

/** Yaw (rotation about +Y) that turns the model's -Z forward into `fwd`. */
export function yawFromForward(fx: number, fz: number): number {
  return Math.atan2(-fx, -fz);
}

export class Track {
  readonly visual: THREE.Object3D;
  readonly walls: WallGrid;
  private readonly roadBVH: MeshBVH;
  private readonly terrainBVH: MeshBVH;

  // racing line (closed loop) as structure-of-arrays
  readonly n: number;
  readonly lx: Float32Array;
  readonly ly: Float32Array;
  readonly lz: Float32Array;
  readonly lspeed: Float32Array; // m/s
  readonly ls: Float32Array; // cumulative distance at point i
  readonly ltx: Float32Array; // unit tangent
  readonly ltz: Float32Array;
  readonly lcurv: Float32Array; // signed curvature (1/m), + = turning left
  readonly roomLeft: Float32Array; // drivable asphalt to the left of the line point
  readonly roomRight: Float32Array;
  readonly length: number;

  readonly checkpoints: Checkpoint[];
  readonly spawns: Spawn[];

  constructor(gltfScene: THREE.Object3D, manifest: Manifest, line: RacingLinePoint[], maxAniso: number) {
    gltfScene.updateMatrixWorld(true);
    const take = (name: string): THREE.BufferGeometry => {
      const obj = gltfScene.getObjectByName(name) as THREE.Mesh | undefined;
      if (!obj || !obj.isMesh) throw new Error(`track collider ${name} missing`);
      const g = obj.geometry.clone();
      g.applyMatrix4(obj.matrixWorld);
      // Colliders never render: detach them entirely (saves draw calls even though the material is invisible).
      obj.removeFromParent();
      return g;
    };
    const road = take('col_road');
    const terrain = take('col_terrain');
    const barriers = take('col_barriers');
    this.roadBVH = new MeshBVH(road);
    this.terrainBVH = new MeshBVH(terrain);
    this.walls = new WallGrid(barriers);

    // ---- visual tweaks
    gltfScene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const name = m.name;
      m.matrixAutoUpdate = false;
      if (/^(road|kerbs|terrain|barriers)/.test(name)) m.receiveShadow = true;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const sm = mat as THREE.MeshStandardMaterial;
        for (const tex of [sm.map, sm.normalMap, sm.roughnessMap]) {
          if (tex) tex.anisotropy = maxAniso;
        }
        if (sm.name === 'tree_foliage' || sm.name === 'painted_vertex_color') sm.envMapIntensity = 0.6;
      }
    });
    this.visual = gltfScene;

    // ---- racing line
    const n = line.length;
    this.n = n;
    this.lx = new Float32Array(n);
    this.ly = new Float32Array(n);
    this.lz = new Float32Array(n);
    this.lspeed = new Float32Array(n);
    this.ls = new Float32Array(n);
    this.ltx = new Float32Array(n);
    this.ltz = new Float32Array(n);
    this.lcurv = new Float32Array(n);
    this.roomLeft = new Float32Array(n);
    this.roomRight = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.lx[i] = line[i].x;
      this.ly[i] = line[i].y;
      this.lz[i] = line[i].z;
      this.lspeed[i] = line[i].speed_kmh * KMH;
    }
    let acc = 0;
    for (let i = 0; i < n; i++) {
      this.ls[i] = acc;
      const j = (i + 1) % n;
      acc += Math.hypot(this.lx[j] - this.lx[i], this.lz[j] - this.lz[i]);
    }
    this.length = acc;
    for (let i = 0; i < n; i++) {
      const p = (i - 1 + n) % n;
      const q = (i + 1) % n;
      const tx = this.lx[q] - this.lx[p];
      const tz = this.lz[q] - this.lz[p];
      const l = Math.hypot(tx, tz) || 1;
      this.ltx[i] = tx / l;
      this.ltz[i] = tz / l;
    }
    for (let i = 0; i < n; i++) {
      const p = (i - 1 + n) % n;
      const q = (i + 1) % n;
      const a0 = Math.atan2(this.ltz[p], this.ltx[p]);
      const a1 = Math.atan2(this.ltz[q], this.ltx[q]);
      let da = a1 - a0;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      const ds = Math.hypot(this.lx[q] - this.lx[p], this.lz[q] - this.lz[p]) || 1;
      // atan2(z, x) increases clockwise seen from above (+Y up, -Z north), so negate for "left = +"
      this.lcurv[i] = -da / ds;
    }
    // Drivable room left/right of every line point, measured on the road collider.
    const hit: GroundHit = { y: 0, nx: 0, ny: 1, nz: 0, surface: 'none' };
    for (let i = 0; i < n; i++) {
      const lxn = this.ltz[i];
      const lzn = -this.ltx[i];
      for (const side of [1, -1]) {
        let room = 0;
        for (let k = 0.5; k <= 16; k += 0.5) {
          const x = this.lx[i] + lxn * k * side;
          const z = this.lz[i] + lzn * k * side;
          if (!this.sampleGround(x, this.ly[i] + 2, z, hit) || hit.surface !== 'road') break;
          room = k;
        }
        if (side > 0) this.roomLeft[i] = room;
        else this.roomRight[i] = room;
      }
    }

    // ---- checkpoints / spawns
    const proj: Projection = { index: 0, s: 0, lateral: 0, dist: 0 };
    this.checkpoints = manifest.track.checkpoints.map((c: CheckpointDef) => {
      const pos = new THREE.Vector3(...c.position);
      const q = new THREE.Quaternion(...c.rotation);
      const m = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1));
      const fwd = new THREE.Vector3(...c.forward).normalize();
      this.project(pos.x, pos.z, -1, proj);
      return {
        index: c.index,
        name: c.name,
        position: pos,
        forward: fwd,
        yaw: yawFromForward(fwd.x, fwd.z),
        halfAcross: c.box_size[0] / 2,
        height: c.box_size[1],
        inv: m.invert(),
        s: proj.s,
      };
    });
    this.spawns = manifest.track.spawns.map((s: SpawnDef) => ({
      position: new THREE.Vector3(...s.position),
      yaw: yawFromForward(s.forward[0], s.forward[2]),
    }));
  }

  /** Raycast straight down onto the drivable colliders. Returns false if nothing below. */
  sampleGround(x: number, y: number, z: number, out: GroundHit): boolean {
    _ray.origin.set(x, y + 2.5, z);
    _ray.direction.set(0, -1, 0);
    const r = this.roadBVH.raycastFirst(_ray, THREE.DoubleSide, 0, 30);
    const t = this.terrainBVH.raycastFirst(_ray, THREE.DoubleSide, 0, 30);
    let hit = r;
    let surface: Surface = 'road';
    // Prefer the road unless the terrain is clearly above it.
    if (t && (!r || t.distance < r.distance - 0.1)) {
      hit = t;
      surface = 'offroad';
    }
    if (!hit) {
      out.surface = 'none';
      return false;
    }
    out.y = hit.point.y;
    const fn = hit.face ? hit.face.normal : _v.set(0, 1, 0);
    const flip = fn.y < 0 ? -1 : 1;
    out.nx = fn.x * flip;
    out.ny = fn.y * flip;
    out.nz = fn.z * flip;
    out.surface = surface;
    return true;
  }

  /** Project an XZ point onto the racing line. `hint` = previous index (or -1 for a global search). */
  project(x: number, z: number, hint: number, out: Projection): Projection {
    const n = this.n;
    let from = 0;
    let to = n - 1;
    if (hint >= 0) {
      from = hint - 12;
      to = hint + 12;
    }
    let bestD = Infinity;
    for (let k = from; k <= to; k++) {
      const i = ((k % n) + n) % n;
      const j = (i + 1) % n;
      const ax = this.lx[i];
      const az = this.lz[i];
      const ex = this.lx[j] - ax;
      const ez = this.lz[j] - az;
      const l2 = ex * ex + ez * ez || 1;
      let t = ((x - ax) * ex + (z - az) * ez) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + ex * t;
      const pz = az + ez * t;
      const d = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d < bestD) {
        bestD = d;
        out.index = i;
        const segLen = Math.sqrt(l2);
        out.s = this.ls[i] + t * segLen;
        // left normal of the segment = (ez, -ex)/len
        out.lateral = ((x - px) * ez + (z - pz) * -ex) / segLen;
      }
    }
    // A local search that drifted far from the line (e.g. after a reset) falls back to a global one.
    if (hint >= 0 && bestD > 30 * 30) return this.project(x, z, -1, out);
    out.dist = Math.sqrt(bestD);
    return out;
  }

  /** Index of the line point at or just before distance s (wraps). */
  indexAt(s: number): number {
    const L = this.length;
    s = ((s % L) + L) % L;
    // points are ~uniformly spaced, so guess then walk
    let i = Math.min(this.n - 1, Math.floor((s / L) * this.n));
    while (i > 0 && this.ls[i] > s) i--;
    while (i < this.n - 1 && this.ls[i + 1] <= s) i++;
    return i;
  }

  /** Interpolated racing-line point at distance s, offset laterally (+ = left). */
  pointAt(s: number, lateral: number, out: THREE.Vector3): THREE.Vector3 {
    const L = this.length;
    s = ((s % L) + L) % L;
    const i = this.indexAt(s);
    const j = (i + 1) % this.n;
    const segEnd = j === 0 ? L : this.ls[j];
    const t = (s - this.ls[i]) / Math.max(1e-6, segEnd - this.ls[i]);
    const x = this.lx[i] + (this.lx[j] - this.lx[i]) * t;
    const y = this.ly[i] + (this.ly[j] - this.ly[i]) * t;
    const z = this.lz[i] + (this.lz[j] - this.lz[i]) * t;
    const tx = this.ltx[i] + (this.ltx[j] - this.ltx[i]) * t;
    const tz = this.ltz[i] + (this.ltz[j] - this.ltz[i]) * t;
    const tl = Math.hypot(tx, tz) || 1;
    return out.set(x + (tz / tl) * lateral, y, z + (-tx / tl) * lateral);
  }

  /** Forward distance along the line from a to b in [0, L). */
  ahead(sFrom: number, sTo: number): number {
    const L = this.length;
    return (((sTo - sFrom) % L) + L) % L;
  }
}
