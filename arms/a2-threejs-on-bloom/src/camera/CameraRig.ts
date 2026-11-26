import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { Vehicle } from '../physics/Vehicle';
import type { CarVisual } from '../game/CarVisual';

export type CameraMode = 'chase' | 'hood';

const _target = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Chase camera with exponential smoothing, speed-dependent FOV (+ nitro kick),
 * high-speed buzz and impact shake. Hood camera is rigidly attached to the chassis.
 */
export class CameraRig {
  mode: CameraMode = 'chase';
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private yaw = 0;
  private fov = 62;
  private shake = 0;
  private t = 0;
  private initialized = false;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  toggle(): void {
    this.mode = this.mode === 'chase' ? 'hood' : 'chase';
    this.initialized = false;
  }

  addShake(amount: number): void {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  snap(): void {
    this.initialized = false;
  }

  update(dt: number, v: Vehicle, vis: CarVisual): void {
    this.t += dt;
    const speedKmh = v.speed * 3.6;
    const root = vis.root;
    const carPos = root.position;

    // FOV: speed + nitro kick
    const boost = v.boosting ? 1 : 0;
    const targetFov = (this.mode === 'chase' ? 60 : 68) + clamp(speedKmh / 250, 0, 1.3) * 16 + boost * 12;
    this.fov += (targetFov - this.fov) * damp(boost ? 6 : 3, dt);

    // shake: high-speed buzz + impact decay
    const buzz = clamp((speedKmh - 170) / 130, 0, 1) * 0.035 + boost * 0.03;
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const amp = buzz + this.shake * 0.35;
    const sx = (Math.sin(this.t * 41.3) + Math.sin(this.t * 27.1 + 1.3)) * 0.5 * amp;
    const sy = (Math.sin(this.t * 37.7 + 0.4) + Math.sin(this.t * 23.3 + 2.1)) * 0.5 * amp;

    const cam = this.camera;
    if (this.mode === 'chase') {
      // follow the velocity direction a little when sliding, the heading otherwise
      // local +Z column of the world matrix is the car's back vector
      const carYaw = Math.atan2(root.matrixWorld.elements[8], root.matrixWorld.elements[10]);
      let velYaw = carYaw;
      if (v.speed > 5) velYaw = Math.atan2(-v.vx, -v.vz);
      let d = velYaw - carYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const wantYaw = carYaw + clamp(d, -0.6, 0.6) * 0.45;
      if (!this.initialized) this.yaw = wantYaw;
      let dy = wantYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * damp(5.5, dt);

      const dist = 6.4 + clamp(speedKmh / 250, 0, 1.2) * 1.4 - boost * 0.4;
      const height = 2.25 + clamp(speedKmh / 250, 0, 1) * 0.15;
      _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      _desired.copy(carPos).addScaledVector(_fwd, -dist);
      _desired.y += height;
      _target.copy(carPos).addScaledVector(_fwd, 3.5);
      _target.y += 1.0;
      if (!this.initialized) {
        this.pos.copy(_desired);
        this.look.copy(_target);
        this.initialized = true;
      }
      // tight horizontal follow, softer vertical to absorb bumps
      const kh = damp(14, dt);
      this.pos.x += (_desired.x - this.pos.x) * kh;
      this.pos.z += (_desired.z - this.pos.z) * kh;
      this.pos.y += (_desired.y - this.pos.y) * damp(7, dt);
      this.look.lerp(_target, damp(16, dt));
      cam.position.copy(this.pos);
      cam.lookAt(this.look);
    } else {
      // hood cam: rigid on the chassis, slightly damped pitch/roll via the root quaternion
      _desired.set(0, 1.28, -0.75).applyQuaternion(root.quaternion).add(carPos);
      cam.position.copy(_desired);
      _q.copy(root.quaternion);
      if (!this.initialized) {
        cam.quaternion.copy(_q);
        this.initialized = true;
      } else cam.quaternion.slerp(_q, damp(20, dt));
    }
    cam.position.x += sx;
    cam.position.y += sy;
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  /** Slow orbit used behind the menus. */
  orbit(dt: number, center: THREE.Vector3): void {
    this.t += dt;
    const a = this.t * 0.12 + 2.2;
    this.camera.position.set(center.x + Math.cos(a) * 15 - 4, center.y + 3.2, center.z + Math.sin(a) * 15);
    this.camera.lookAt(center.x - 2, center.y + 0.6, center.z);
    if (this.camera.fov !== 50) {
      this.camera.fov = 50;
      this.camera.updateProjectionMatrix();
    }
    this.initialized = false;
  }
}
