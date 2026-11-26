import * as THREE from 'three';

/**
 * The barrier collider is a set of closed vertical walls. For an arcade racer the
 * walls are effectively 2D: we project every near-vertical triangle onto the XZ
 * plane as a line segment and store the segments in a uniform hash grid.
 * Car bodies are a few circles, so wall tests are cheap circle-vs-segment checks,
 * and a swept test on the car centre makes tunnelling impossible.
 */
export class WallGrid {
  /** x1, z1, x2, z2 per segment */
  readonly seg: Float32Array;
  readonly count: number;
  private readonly cell: number;
  private readonly cells = new Map<number, Int32Array>();
  private readonly stamp: Uint32Array;
  private stampId = 1;
  private readonly scratch: number[] = [];

  constructor(geometry: THREE.BufferGeometry, cellSize = 8) {
    this.cell = cellSize;
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const index = geometry.getIndex();
    const triCount = index ? index.count / 3 : pos.count / 3;
    const segs: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    const dedupe = new Set<string>();
    const key = (x1: number, z1: number, x2: number, z2: number): string => {
      const q = (v: number) => Math.round(v * 20);
      const k1 = `${q(x1)},${q(z1)}`;
      const k2 = `${q(x2)},${q(z2)}`;
      return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
    };
    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      n.subVectors(b, a).cross(c.clone().sub(a));
      const len = n.length();
      if (len < 1e-8) continue;
      n.divideScalar(len);
      if (Math.abs(n.y) > 0.5) continue; // caps / floors are not walls
      // The projected triangle collapses onto a segment: keep its longest XZ edge.
      const pts = [a, b, c];
      let best = -1;
      let bi = 0;
      let bj = 1;
      for (let i = 0; i < 3; i++) {
        for (let j = i + 1; j < 3; j++) {
          const dx = pts[i].x - pts[j].x;
          const dz = pts[i].z - pts[j].z;
          const d = dx * dx + dz * dz;
          if (d > best) {
            best = d;
            bi = i;
            bj = j;
          }
        }
      }
      if (best < 1e-4) continue;
      const p = pts[bi];
      const q = pts[bj];
      const k = key(p.x, p.z, q.x, q.z);
      if (dedupe.has(k)) continue;
      dedupe.add(k);
      segs.push(p.x, p.z, q.x, q.z);
    }
    this.seg = new Float32Array(segs);
    this.count = segs.length / 4;
    this.stamp = new Uint32Array(this.count);

    const tmp = new Map<number, number[]>();
    for (let s = 0; s < this.count; s++) {
      const o = s * 4;
      const minX = Math.min(this.seg[o], this.seg[o + 2]);
      const maxX = Math.max(this.seg[o], this.seg[o + 2]);
      const minZ = Math.min(this.seg[o + 1], this.seg[o + 3]);
      const maxZ = Math.max(this.seg[o + 1], this.seg[o + 3]);
      for (let cx = Math.floor(minX / cellSize); cx <= Math.floor(maxX / cellSize); cx++) {
        for (let cz = Math.floor(minZ / cellSize); cz <= Math.floor(maxZ / cellSize); cz++) {
          const kk = this.cellKey(cx, cz);
          let arr = tmp.get(kk);
          if (!arr) tmp.set(kk, (arr = []));
          arr.push(s);
        }
      }
    }
    for (const [k, v] of tmp) this.cells.set(k, Int32Array.from(v));
  }

  private cellKey(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  /** Collect unique segment indices whose cells overlap the given XZ AABB. */
  query(minX: number, minZ: number, maxX: number, maxZ: number): number[] {
    const out = this.scratch;
    out.length = 0;
    this.stampId++;
    if (this.stampId > 0xfffffff0) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
    const c = this.cell;
    for (let cx = Math.floor(minX / c); cx <= Math.floor(maxX / c); cx++) {
      for (let cz = Math.floor(minZ / c); cz <= Math.floor(maxZ / c); cz++) {
        const arr = this.cells.get(this.cellKey(cx, cz));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const s = arr[i];
          if (this.stamp[s] !== this.stampId) {
            this.stamp[s] = this.stampId;
            out.push(s);
          }
        }
      }
    }
    return out;
  }

  /**
   * First intersection of the XZ segment p0->p1 with any wall, as a fraction t in [0,1],
   * or -1 if the path is clear. Normal (pointing back towards p0) is written to outN.
   */
  sweep(x0: number, z0: number, x1: number, z1: number, outN: { x: number; z: number }): number {
    const list = this.query(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1));
    const dx = x1 - x0;
    const dz = z1 - z0;
    let bestT = 2;
    for (let i = 0; i < list.length; i++) {
      const o = list[i] * 4;
      const ax = this.seg[o];
      const az = this.seg[o + 1];
      const ex = this.seg[o + 2] - ax;
      const ez = this.seg[o + 3] - az;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((ax - x0) * ez - (az - z0) * ex) / den;
      const u = ((ax - x0) * dz - (az - z0) * dx) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < bestT) {
        bestT = t;
        let nx = -ez;
        let nz = ex;
        const l = Math.hypot(nx, nz) || 1;
        nx /= l;
        nz /= l;
        if (nx * dx + nz * dz > 0) {
          nx = -nx;
          nz = -nz;
        }
        outN.x = nx;
        outN.z = nz;
      }
    }
    return bestT <= 1 ? bestT : -1;
  }
}
