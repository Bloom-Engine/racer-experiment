/**
 * Procedural effects, all as plain three.js Meshes (the Bloom bridge doesn't draw Points,
 * Lines or Sprites): speed lines around the camera, skid marks, impact sparks, drift smoke.
 */
import * as THREE from "three";

/** Speed lines: thin streaks around the view axis, children of the camera. */
export class SpeedLines {
  private readonly lines: THREE.Mesh[] = [];
  private readonly mat = new THREE.MeshBasicMaterial({ color: 0xdfe8ff, transparent: true, opacity: 0.5 });
  private readonly seeds: number[] = [];

  constructor(camera: THREE.Camera, count = 22) {
    const geo = new THREE.BoxGeometry(0.02, 0.02, 2.2);
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, this.mat);
      m.visible = false;
      camera.add(m);
      this.lines.push(m);
      this.seeds.push(Math.random());
    }
  }

  update(intensity: number, dt: number): void {
    const on = intensity > 0.02;
    this.mat.opacity = Math.min(0.65, intensity * 0.65);
    for (let i = 0; i < this.lines.length; i++) {
      const m = this.lines[i]!;
      m.visible = on;
      if (!on) continue;
      // each streak flies from far ahead to behind the camera, on a ring around the view axis
      let s = this.seeds[i]! - dt * (1.2 + intensity * 1.6);
      if (s < 0) s += 1;
      this.seeds[i] = s;
      const ang = i * 2.399 + Math.floor(s * 3) * 0.7;   // golden-angle spread
      const r = 3.2 + ((i * 37) % 10) * 0.25;
      m.position.set(Math.cos(ang) * r * 1.6, Math.sin(ang) * r * 0.9, -4 - s * 30);
    }
  }
}

/** Skid marks: a ring buffer of quads in one geometry, re-uploaded a few times a second. */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly max: number;
  private readonly pos: Float32Array;
  private next = 0;
  private dirty = false;
  private sinceUpload = 0;
  private last = new Map<number, { x: number; y: number; z: number }>();

  constructor(scene: THREE.Scene, max = 360) {
    this.max = max;
    this.pos = new Float32Array(max * 4 * 3);
    const nor = new Float32Array(max * 4 * 3);
    for (let i = 0; i < max * 4; i++) nor[i * 3 + 1] = 1;
    const idx: number[] = [];
    // both windings: the bridge has no double-sided materials, and the quads must face up
    for (let q = 0; q < max; q++) { const b = q * 4; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3, b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 1, transparent: true, opacity: 0.55 }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** key identifies a wheel; call each frame with its contact point while it slides. */
  add(key: number, x: number, y: number, z: number, rx: number, rz: number): void {
    const prev = this.last.get(key);
    const cur = { x, y: y + 0.03, z };
    if (prev !== undefined) {
      const d = Math.hypot(cur.x - prev.x, cur.z - prev.z);
      if (d < 0.6) return;
      if (d < 4) {
        const w = 0.13;
        const q = this.next;
        this.next = (this.next + 1) % this.max;
        const p = this.pos, o = q * 12;
        p[o] = prev.x - rx * w; p[o + 1] = prev.y; p[o + 2] = prev.z - rz * w;
        p[o + 3] = prev.x + rx * w; p[o + 4] = prev.y; p[o + 5] = prev.z + rz * w;
        p[o + 6] = cur.x - rx * w; p[o + 7] = cur.y; p[o + 8] = cur.z - rz * w;
        p[o + 9] = cur.x + rx * w; p[o + 10] = cur.y; p[o + 11] = cur.z + rz * w;
        this.dirty = true;
      }
    }
    this.last.set(key, cur);
  }

  lift(key: number): void { this.last.delete(key); }

  update(dt: number): void {
    this.sinceUpload += dt;
    if (this.dirty && this.sinceUpload > 0.2) {
      (this.mesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      this.dirty = false; this.sinceUpload = 0;
    }
  }

  clear(): void {
    this.pos.fill(0); this.last.clear(); this.next = 0;
    (this.mesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}

interface Particle { mesh: THREE.Mesh; vel: THREE.Vector3; life: number; maxLife: number; grow: number }

/** Small pooled particle bursts made of meshes: sparks (glowing) and smoke (fading). */
export class Particles {
  private readonly pool: Particle[] = [];
  private cursor = 0;

  constructor(scene: THREE.Scene, private readonly kind: "spark" | "smoke", count: number) {
    const geo = kind === "spark" ? new THREE.BoxGeometry(0.06, 0.06, 0.32) : new THREE.IcosahedronGeometry(0.22, 1);
    for (let i = 0; i < count; i++) {
      const mat = kind === "spark"
        ? new THREE.MeshBasicMaterial({ color: 0xffb040 })
        : new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 1, transparent: true, opacity: 0.4 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.pool.push({ mesh, vel: new THREE.Vector3(), life: 0, maxLife: 1, grow: 0 });
    }
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, spread: number, life: number): void {
    const p = this.pool[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.pool.length;
    p.mesh.position.set(x, y, z);
    p.vel.set(vx + (Math.random() - 0.5) * spread, vy + Math.random() * spread * 0.5, vz + (Math.random() - 0.5) * spread);
    p.life = life; p.maxLife = life;
    p.grow = this.kind === "smoke" ? 1.1 : 0;
    p.mesh.scale.setScalar(this.kind === "smoke" ? 0.5 : 1);
    p.mesh.visible = true;
  }

  update(dt: number): void {
    for (const p of this.pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.mesh.visible = false; continue; }
      const t = p.life / p.maxLife;
      if (this.kind === "spark") {
        p.vel.y -= 9.81 * dt;
        p.mesh.position.addScaledVector(p.vel, dt);
        p.mesh.lookAt(p.mesh.position.x + p.vel.x, p.mesh.position.y + p.vel.y, p.mesh.position.z + p.vel.z);
      } else {
        p.vel.multiplyScalar(1 - dt * 1.5);
        p.vel.y += dt * 0.6;
        p.mesh.position.addScaledVector(p.vel, dt);
        p.mesh.scale.multiplyScalar(1 + p.grow * dt);
        (p.mesh.material as THREE.MeshStandardMaterial).opacity = 0.38 * t;
      }
    }
  }

  clear(): void { for (const p of this.pool) { p.life = 0; p.mesh.visible = false; } }
}
