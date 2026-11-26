/**
 * Chase and bumper cameras: plain three.js camera work. Smoothing, speed-dependent FOV,
 * a nitro FOV kick, high-speed shake and impact shake.
 */
import * as THREE from "three";

export type CameraMode = "chase" | "bumper";

export class CameraRig {
  mode: CameraMode = "chase";
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private fov = 65;
  private shake = 0;
  private initialised = false;
  private readonly tmp = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly up = new THREE.Vector3();

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  toggle(): void { this.mode = this.mode === "chase" ? "bumper" : "chase"; this.initialised = false; }
  impact(strength: number): void { this.shake = Math.min(1.2, this.shake + strength); }
  snap(): void { this.initialised = false; }

  /** target = the car's root object (already synced from physics this frame). */
  update(target: THREE.Object3D, speed: number, nitro: boolean, dt: number, time: number): void {
    const cam = this.camera;
    this.fwd.set(0, 0, -1).applyQuaternion(target.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(target.quaternion);
    const kmh = Math.abs(speed) * 3.6;

    // FOV: wider with speed, kick on nitro
    const fovTarget = (this.mode === "chase" ? 62 : 72) + Math.min(kmh, 300) * 0.07 + (nitro ? 12 : 0);
    this.fov += (fovTarget - this.fov) * Math.min(1, dt * (nitro ? 6 : 2.5));
    cam.fov = this.fov;
    cam.updateProjectionMatrix();

    if (this.mode === "chase") {
      // behind and above, flattened forward so pitching over crests doesn't throw the camera
      const flat = this.tmp.set(this.fwd.x, 0, this.fwd.z);
      if (flat.lengthSq() < 1e-4) flat.set(0, 0, -1);
      flat.normalize();
      const back = 6.4 + Math.min(kmh, 300) * 0.006;
      // smooth the camera's OFFSET from the car (its swing around the car), not its world
      // position — a lerped world position falls behind further the faster the car goes
      const wantOff = new THREE.Vector3().copy(flat).multiplyScalar(-back).add(new THREE.Vector3(0, 2.3, 0));
      const wantLookOff = new THREE.Vector3().copy(flat).multiplyScalar(4).add(new THREE.Vector3(0, 0.9, 0));
      if (!this.initialised) { this.pos.copy(wantOff); this.look.copy(wantLookOff); this.initialised = true; }
      this.pos.lerp(wantOff, 1 - Math.exp(-dt * 5));
      this.look.lerp(wantLookOff, 1 - Math.exp(-dt * 10));
      cam.position.copy(target.position).add(this.pos);
      // a little lag behind the car under acceleration (sense of speed), bounded
      cam.position.addScaledVector(flat, -Math.min(1.2, Math.max(0, kmh - 120) / 150));
      // never sink below the car's height (crests, dips)
      if (cam.position.y < target.position.y + 1.2) cam.position.y = target.position.y + 1.2;
      cam.up.set(0, 1, 0);
    } else {
      // bumper/hood: rigid on the car, just above the bonnet
      const p = new THREE.Vector3(0, 1.22, -1.15).applyQuaternion(target.quaternion).add(target.position);
      cam.position.copy(p);
      this.look.copy(p).addScaledVector(this.fwd, 20);
      cam.up.copy(this.up);
    }

    // shake: a little at high speed, a lot on impacts, decaying
    const speedShake = Math.max(0, kmh - 170) / 130 * 0.035 + (nitro ? 0.03 : 0);
    const s = speedShake + this.shake * 0.25;
    if (s > 0.0005) {
      cam.position.x += (Math.sin(time * 71.3) + Math.sin(time * 43.1)) * 0.5 * s;
      cam.position.y += (Math.sin(time * 67.7) + Math.sin(time * 31.9)) * 0.5 * s;
    }
    this.shake = Math.max(0, this.shake - dt * 2.5);
    if (this.mode === "chase") cam.lookAt(this.tmp.copy(target.position).add(this.look));
    else cam.lookAt(this.look);
  }
}
