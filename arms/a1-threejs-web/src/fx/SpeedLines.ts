import * as THREE from 'three';
import { rng } from '../core/math';

const COUNT = 60;

/** Streaks rushing past the camera during nitro / very high speed (camera-space instanced quads). */
export class SpeedLines {
  readonly mesh: THREE.InstancedMesh;
  private readonly z = new Float32Array(COUNT);
  private readonly ang = new Float32Array(COUNT);
  private readonly rad = new Float32Array(COUNT);
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly axis = new THREE.Vector3(0, 0, 1);
  private intensity = 0;
  private readonly rand = rng(7);

  constructor() {
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2); // lie in XZ: x = tangential width, z = streak length
    const colors = new Float32Array(4 * 3);
    // fade the far end
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const far = pos.getZ(i) < 0 ? 0.0 : 1.0;
      colors.set([far, far, far], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xdfefff,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide, // the camera sits inside the cylinder of streaks
      fog: false,
    });
    this.mesh = new THREE.InstancedMesh(g, this.mat, COUNT);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    for (let i = 0; i < COUNT; i++) this.respawn(i, true);
  }

  private respawn(i: number, initial: boolean): void {
    this.ang[i] = this.rand() * Math.PI * 2;
    this.rad[i] = 2.2 + this.rand() * 2.4;
    this.z[i] = initial ? -2 - this.rand() * 40 : -36 - this.rand() * 8;
  }

  update(dt: number, target: number, speed: number): void {
    this.intensity += (target - this.intensity) * (1 - Math.exp(-6 * dt));
    this.mesh.visible = this.intensity > 0.02;
    if (!this.mesh.visible) return;
    this.mat.opacity = this.intensity * 0.5;
    const v = 40 + speed * 1.2;
    for (let i = 0; i < COUNT; i++) {
      this.z[i] += v * dt;
      if (this.z[i] > -1.5) this.respawn(i, false);
      const len = 1.5 + speed * 0.05;
      this.q.setFromAxisAngle(this.axis, this.ang[i]);
      this.p.set(0, this.rad[i], this.z[i]).applyQuaternion(this.q);
      this.s.set(0.04, 1, len);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
