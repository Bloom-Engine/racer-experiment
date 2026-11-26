import * as THREE from 'three';

const MAX_QUADS = 2400;

/** Tyre marks: one dynamic mesh used as a ring buffer of quads (single draw call). */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private cursor = 0;
  private readonly last = new Map<number, { x: number; y: number; z: number; rx: number; rz: number }>();
  private dirtyFrom = Infinity;
  private dirtyTo = -1;

  constructor() {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX_QUADS * 4 * 3);
    this.col = new Float32Array(MAX_QUADS * 4 * 4);
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('color', this.colAttr);
    const idx = new Uint16Array(MAX_QUADS * 6);
    for (let i = 0; i < MAX_QUADS; i++) {
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const m = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      fog: true,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Feed one wheel contact; `strength` 0 ends the current streak. */
  add(id: number, x: number, y: number, z: number, rx: number, rz: number, strength: number, width = 0.26): void {
    const prev = this.last.get(id);
    if (strength <= 0.02) {
      this.last.delete(id);
      return;
    }
    if (!prev) {
      this.last.set(id, { x, y, z, rx, rz });
      return;
    }
    const dx = x - prev.x;
    const dz = z - prev.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < 0.3 * 0.3) return; // wait for a bit of distance
    if (d2 > 6 * 6) {
      this.last.set(id, { x, y, z, rx, rz });
      return;
    }
    const q = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_QUADS;
    const hw = width / 2;
    const yo = 0.025;
    const p = this.pos;
    let o = q * 12;
    p[o++] = prev.x - prev.rx * hw;
    p[o++] = prev.y + yo;
    p[o++] = prev.z - prev.rz * hw;
    p[o++] = prev.x + prev.rx * hw;
    p[o++] = prev.y + yo;
    p[o++] = prev.z + prev.rz * hw;
    p[o++] = x - rx * hw;
    p[o++] = y + yo;
    p[o++] = z - rz * hw;
    p[o++] = x + rx * hw;
    p[o++] = y + yo;
    p[o++] = z + rz * hw;
    const a = Math.min(0.55, strength * 0.55);
    let c = q * 16;
    for (let k = 0; k < 4; k++) {
      this.col[c++] = 0.04;
      this.col[c++] = 0.04;
      this.col[c++] = 0.045;
      this.col[c++] = a;
    }
    this.last.set(id, { x, y, z, rx, rz });
    this.dirtyFrom = Math.min(this.dirtyFrom, q);
    this.dirtyTo = Math.max(this.dirtyTo, q);
  }

  flush(): void {
    if (this.dirtyTo < 0) return;
    const from = this.dirtyFrom;
    const count = this.dirtyTo - from + 1;
    this.posAttr.clearUpdateRanges();
    this.posAttr.addUpdateRange(from * 12, count * 12);
    this.posAttr.needsUpdate = true;
    this.colAttr.clearUpdateRanges();
    this.colAttr.addUpdateRange(from * 16, count * 16);
    this.colAttr.needsUpdate = true;
    this.dirtyFrom = Infinity;
    this.dirtyTo = -1;
  }

  clear(): void {
    this.pos.fill(0);
    this.col.fill(0);
    this.posAttr.clearUpdateRanges();
    this.colAttr.clearUpdateRanges();
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.last.clear();
    this.cursor = 0;
  }
}
