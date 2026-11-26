// Chase camera (smoothed, speed-dependent FOV, shake) + bumper camera.
import { Camera3D } from "bloom/core";
import { Car } from "./vehicle";
import { V3, Q4, qRotate, smoothK, clampN, lerpN } from "./util/math3d";
import * as C from "./config";

export const CamMode = { Chase: 0, Bumper: 1 };

export class RaceCamera {
  mode: number = CamMode.Chase;
  cam: Camera3D = {
    position: { x: 0, y: 5, z: 10 },
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    fovy: 60,
    projection: "perspective",
  };
  private pos: V3 = { x: 0, y: 5, z: 10 };
  private look: V3 = { x: 0, y: 0, z: 0 };
  private headX = 0;
  private headZ = -1;
  private fov = 60;
  private nitroKick = 0;
  private shake = 0;
  private t = 0;
  private initialised = false;
  private rp: V3 = { x: 0, y: 0, z: 0 };
  private rq: Q4 = { x: 0, y: 0, z: 0, w: 1 };
  private tmp: V3 = { x: 0, y: 0, z: 0 };

  // Keep this explicit constructor: Perry's wasm target (0.5.1664) skips all
  // field initialisers of a class that has none, leaving `cam` undefined in
  // the browser build (no 3D at all).
  constructor() {}

  toggle(): void {
    if (this.mode === CamMode.Chase) this.mode = CamMode.Bumper;
    else this.mode = CamMode.Chase;
  }

  addImpact(strength: number): void {
    this.shake = Math.min(1.2, this.shake + strength * 0.08);
  }

  snap(): void { this.initialised = false; }

  update(car: Car, alpha: number, dt: number): void {
    this.t += dt;
    const p = car.renderPos(alpha, this.rp);
    const q = car.renderRotation(alpha, this.rq);
    const speed = Math.abs(car.speed);
    const sf = clampN(speed / C.TOP_SPEED, 0, 1.25);

    // FOV: speed + nitro kick
    let kickTarget = 0;
    if (car.nitroActive) kickTarget = 1;
    this.nitroKick = lerpN(this.nitroKick, kickTarget, smoothK(car.nitroActive ? 6 : 2.5, dt));
    const baseFov = this.mode === CamMode.Chase ? 58 : 68;
    const targetFov = baseFov + sf * 16 + this.nitroKick * 12;
    this.fov = lerpN(this.fov, targetFov, smoothK(4, dt));

    // shake: high speed rumble + impacts
    this.shake = Math.max(0, this.shake - dt * 1.8);
    let amp = this.shake * 0.35;
    if (speed > 45) amp += (speed - 45) * 0.0022;
    if (car.nitroActive) amp += 0.03;
    const sx = (Math.sin(this.t * 37.0) + Math.sin(this.t * 23.3 + 1.3)) * 0.5 * amp;
    const sy = (Math.sin(this.t * 41.0 + 0.7) + Math.sin(this.t * 19.1)) * 0.5 * amp;

    if (this.mode === CamMode.Bumper) {
      const f = qRotate(q, 0, 0, -1, this.tmp);
      const fx = f.x, fy = f.y, fz = f.z;
      const o = qRotate(q, 0, 1.08, -0.55, this.tmp);
      this.cam.position.x = p.x + o.x + sx * 0.3;
      this.cam.position.y = p.y + o.y + sy * 0.3;
      this.cam.position.z = p.z + o.z;
      this.cam.target.x = this.cam.position.x + fx * 20;
      this.cam.target.y = this.cam.position.y + fy * 20 - 0.6;
      this.cam.target.z = this.cam.position.z + fz * 20;
      this.cam.fovy = this.fov;
      this.initialised = false;
      return;
    }

    // heading: blend car facing with velocity direction (looks great in drifts)
    const f = qRotate(q, 0, 0, -1, this.tmp);
    let hx = f.x, hz = f.z;
    if (speed > 6) {
      const vl = Math.sqrt(car.vel.x * car.vel.x + car.vel.z * car.vel.z) + 1e-6;
      const w = 0.45;
      if (car.speed > 0) {
        hx = hx * (1 - w) + (car.vel.x / vl) * w;
        hz = hz * (1 - w) + (car.vel.z / vl) * w;
      }
    }
    const hl = Math.sqrt(hx * hx + hz * hz) + 1e-6;
    hx /= hl; hz /= hl;
    if (!this.initialised) { this.headX = hx; this.headZ = hz; }
    const hk = smoothK(5.5, dt);
    this.headX = lerpN(this.headX, hx, hk);
    this.headZ = lerpN(this.headZ, hz, hk);
    const hl2 = Math.sqrt(this.headX * this.headX + this.headZ * this.headZ) + 1e-6;
    const ux = this.headX / hl2, uz = this.headZ / hl2;

    const dist = 6.4 + sf * 1.6 - this.nitroKick * 0.6;
    const height = 2.15 + sf * 0.25;
    const desiredX = p.x - ux * dist;
    const desiredY = p.y + height;
    const desiredZ = p.z - uz * dist;
    if (!this.initialised) {
      this.pos.x = desiredX; this.pos.y = desiredY; this.pos.z = desiredZ;
      this.look.x = p.x; this.look.y = p.y + 1; this.look.z = p.z;
      this.initialised = true;
    }
    // follow rigidly along the heading (no speed-proportional lag), smooth height
    this.pos.x = desiredX;
    this.pos.y = lerpN(this.pos.y, desiredY, smoothK(6, dt));
    this.pos.z = desiredZ;
    const lk = smoothK(18, dt);
    this.look.x = lerpN(this.look.x, p.x + ux * 4, lk);
    this.look.y = lerpN(this.look.y, p.y + 1.05, lk);
    this.look.z = lerpN(this.look.z, p.z + uz * 4, lk);

    this.cam.position.x = this.pos.x + sx * -uz;
    this.cam.position.y = this.pos.y + sy;
    this.cam.position.z = this.pos.z + sx * ux;
    this.cam.target.x = this.look.x;
    this.cam.target.y = this.look.y;
    this.cam.target.z = this.look.z;
    this.cam.fovy = this.fov;
  }

  /** Slow orbit around a point (menus / finish screen). */
  orbit(cx: number, cy: number, cz: number, radius: number, height: number, dt: number): void {
    this.t += dt;
    const a = this.t * 0.12;
    this.cam.position.x = cx + Math.cos(a) * radius;
    this.cam.position.y = cy + height;
    this.cam.position.z = cz + Math.sin(a) * radius;
    this.cam.target.x = cx; this.cam.target.y = cy + 0.8; this.cam.target.z = cz;
    this.cam.fovy = 50;
    this.initialised = false;
  }
}
