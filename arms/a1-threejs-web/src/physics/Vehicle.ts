import * as THREE from 'three';
import { CAR, NITRO, WALL } from '../core/config';
import { clamp, damp, sign } from '../core/math';
import type { GroundHit, Track } from '../track/Track';
import type { WallGrid } from '../track/WallGrid';

export interface Controls {
  throttle: number; // 0..1
  brake: number; // 0..1 (also reverse when slow)
  steer: number; // -1..1, + = left
  handbrake: boolean;
  nitro: boolean;
}

export const emptyControls = (): Controls => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false });

const INV_MASS = 1 / CAR.mass;
// Yaw inertia of a 4.6 x 2.0 m box
const INV_INERTIA = 1 / ((CAR.mass * (4.6 * 4.6 + 2.0 * 2.0)) / 12);
const TOP = CAR.topSpeed * 1.035; // asymptotic curve: lets the needle actually reach ~250

/**
 * Arcade vehicle. Planar dynamics in (forward, lateral) components plus yaw rate,
 * with a separate ground-following vertical channel. Deliberately not a rigid-body
 * simulation: everything here is tuned for feel and stability at 300 km/h.
 */
export class Vehicle {
  readonly pos = new THREE.Vector3();
  vx = 0;
  vz = 0;
  vy = 0;
  heading = 0;
  yawRate = 0;

  // previous physics step (for sweeps) and previous render frame (for interpolation)
  private px = 0;
  private pz = 0;
  private pHeading = 0;
  readonly renderPrevPos = new THREE.Vector3();
  renderPrevHeading = 0;

  readonly ground: GroundHit = { y: 0, nx: 0, ny: 1, nz: 0, surface: 'road' };
  grounded = true;
  readonly up = new THREE.Vector3(0, 1, 0);

  forwardSpeed = 0;
  lateralSpeed = 0;
  speed = 0;
  slip = 0; // slip angle magnitude (rad)
  drifting = false;
  driftDir = 0;
  driftTime = 0;
  private gripRecover = 1;
  private velAngle = 0;
  private velTurnRate = 0;

  nitro = 0.35;
  boosting = false;
  boostTime = 0;

  gear = 1;
  rpm: number = CAR.idleRpm;
  shiftTimer = 0;
  shiftedUp = false; // true for one step after an upshift (audio cue)

  steerAngle = 0;
  wheelSpin = 0;
  longAccel = 0;
  latAccel = 0;

  braking = false;
  /** strongest impact this frame (delta-v in m/s); consumers reset it */
  impact = 0;
  impactX = 0;
  impactZ = 0;
  landing = 0;

  ghostTime = 0; // after a reset: no car-car collisions

  get fx(): number {
    return -Math.sin(this.heading);
  }
  get fz(): number {
    return -Math.cos(this.heading);
  }

  reset(x: number, y: number, z: number, yaw: number, speed: number): void {
    this.pos.set(x, y, z);
    this.heading = yaw;
    this.vx = -Math.sin(yaw) * speed;
    this.vz = -Math.cos(yaw) * speed;
    this.vy = 0;
    this.yawRate = 0;
    this.drifting = false;
    this.boosting = false;
    this.grounded = true;
    this.gripRecover = 1;
    this.velAngle = yaw;
    this.velTurnRate = 0;
    this.px = x;
    this.pz = z;
    this.pHeading = yaw;
    this.renderPrevPos.copy(this.pos);
    this.renderPrevHeading = yaw;
    this.up.set(0, 1, 0);
    this.forwardSpeed = speed;
    this.speed = Math.abs(speed);
    this.lateralSpeed = 0;
  }

  /** Engine-only update while the car is held (countdown): lets the player rev. */
  idle(dt: number, c: Controls): void {
    const target = CAR.idleRpm + c.throttle * 5200;
    this.rpm += (target - this.rpm) * damp(c.throttle > this.rpm / 8000 ? 9 : 4, dt);
    this.gear = 1;
    this.braking = c.brake > 0;
  }

  step(dt: number, c: Controls, track: Track): void {
    this.px = this.pos.x;
    this.pz = this.pos.z;
    this.pHeading = this.heading;
    this.renderPrevPos.copy(this.pos);
    this.renderPrevHeading = this.heading;
    this.shiftedUp = false;
    if (this.ghostTime > 0) this.ghostTime -= dt;

    const g = this.ground;
    const onRoad = g.surface === 'road';
    const grip = onRoad ? 1 : CAR.offroadGrip;

    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    const fx = -sinH;
    const fz = -cosH;
    const rx = cosH;
    const rz = -sinH;
    let vF = this.vx * fx + this.vz * fz;
    let vL = this.vx * rx + this.vz * rz;
    const speed = Math.hypot(vF, vL);
    const absSteer = Math.abs(c.steer);

    // ---------------------------------------------------------------- drift state
    // signed slip angle: + when the nose points left of the direction of travel
    const slipSigned = speed > 2 ? Math.atan2(vL, Math.max(0.5, vF)) : 0;
    if (!this.drifting && this.grounded && c.handbrake && vF > 11 && absSteer > 0.2) {
      this.drifting = true;
      this.driftDir = sign(c.steer);
      this.driftTime = 0;
      this.yawRate += this.driftDir * 0.6; // flick the tail out
    }
    if (this.drifting) {
      this.driftTime += dt;
      const s = slipSigned * this.driftDir;
      if (vF < 7 || s < -0.05 || (!c.handbrake && this.driftTime > 0.3 && s < 0.09)) {
        this.drifting = false;
        this.gripRecover = 0;
      }
    }
    if (this.gripRecover < 1) this.gripRecover = Math.min(1, this.gripRecover + dt / 0.45);

    // ---------------------------------------------------------------- nitro
    const wantBoost = c.nitro && c.throttle > 0.05 && vF > 2;
    if (wantBoost && (this.boosting ? this.nitro > 0 : this.nitro >= NITRO.minToStart)) {
      this.boosting = true;
      this.nitro = Math.max(0, this.nitro - NITRO.burnPerSecond * dt);
      this.boostTime += dt;
    } else {
      this.boosting = false;
      this.boostTime = 0;
    }
    if (this.drifting && speed > 14) this.nitro = Math.min(1, this.nitro + NITRO.driftFillPerSecond * dt);

    // ---------------------------------------------------------------- longitudinal
    let a = 0;
    this.braking = false;
    if (this.grounded) {
      if (c.throttle > 0 && vF > -1) {
        const t = vF / TOP;
        let engine = CAR.engineAccel * (1 - t * t);
        if (engine < 0) engine *= 0.5; // above top speed (after nitro): gentle aero decel
        if (this.shiftTimer > 0) engine *= 0.3;
        a += c.throttle * engine * (onRoad ? 1 : 0.75);
      }
      if (this.boosting) {
        const t = vF / CAR.nitroTopSpeed;
        a += CAR.nitroAccel * Math.max(0, 1 - t * t * t);
      }
      if (c.brake > 0) {
        if (vF > 0.5) {
          a -= CAR.brakeDecel * c.brake;
          this.braking = true;
        } else if (c.throttle < 0.05 && vF > -CAR.reverseMax) {
          a -= CAR.reverseAccel * c.brake;
        }
      } else if (c.throttle > 0 && vF < -0.5) {
        a += CAR.brakeDecel * 0.8; // throttle while rolling backwards = brake
      }
      const dir = sign(vF);
      if (c.throttle === 0 && c.brake === 0) a -= dir * CAR.engineBraking;
      a -= dir * CAR.rollingDrag;
      if (!onRoad) a -= dir * (CAR.offroadDrag + CAR.offroadDragQuad * vF * vF);
      if (this.drifting) a -= dir * CAR.driftDrag;
      if (c.handbrake) {
        a -= dir * (this.drifting ? 1.5 : CAR.handbrakeDecel);
        this.braking = true;
      }
      // slope: gravity along the forward direction projected on the ground plane
      const fDotN = fx * g.nx + fz * g.nz;
      const fgy = -fDotN * g.ny; // y component of forward projected on ground plane
      a -= CAR.gravity * fgy * 0.8;
    }
    const newVF = vF + a * dt;
    // Brakes and drag stop the car, they don't push it backwards.
    if (vF > 0 && newVF < 0 && !(c.brake > 0 && c.throttle === 0 && vF < 0.6)) vF = 0;
    else if (vF < 0 && newVF > 0 && c.throttle === 0) vF = 0;
    else vF = newVF;

    // ---------------------------------------------------------------- yaw
    const maxSteer = CAR.minSteer + (CAR.maxSteerLow - CAR.minSteer) / (1 + speed / CAR.steerFalloff);
    this.steerAngle = c.steer * maxSteer;
    if (this.grounded) {
      if (this.drifting) {
        // Steering picks a target drift angle (~0..40 deg); yaw follows the velocity's own
        // rotation plus a correction towards that angle. Self-stabilising: no spin-outs.
        const u = c.steer * this.driftDir;
        let target = u >= 0 ? CAR.driftSlipNeutral + (CAR.driftSlipMax - CAR.driftSlipNeutral) * u : CAR.driftSlipNeutral * (1 + u);
        if (c.handbrake) target = Math.max(target, CAR.driftSlipHandbrake);
        const err = target * this.driftDir - slipSigned;
        const want = this.velTurnRate + clamp(err * CAR.driftSlipGain, -2.2, 2.2);
        this.yawRate += (want - this.yawRate) * damp(CAR.driftYawRate, dt);
      } else {
        let target = (vF * Math.tan(this.steerAngle)) / CAR.wheelbase;
        const lim = (CAR.latAccelMax * grip) / Math.max(4, Math.abs(vF));
        target = clamp(target, -lim, lim);
        this.yawRate += (target - this.yawRate) * damp(CAR.gripYawRate, dt);
      }
    } else {
      this.yawRate *= 1 - damp(1.5, dt);
    }

    // ---------------------------------------------------------------- lateral grip
    if (this.grounded) {
      let k = this.drifting
        ? CAR.driftLateralGrip
        : (CAR.driftLateralGrip + (CAR.lateralGrip - CAR.driftLateralGrip) * this.gripRecover) * grip;
      if (c.handbrake && !this.drifting) k *= 0.45;
      let newVL = vL * Math.exp(-k * dt);
      // Tyres can only provide so much lateral force: beyond it the car slides.
      const maxDelta = CAR.latAccelMax * 1.35 * grip * dt;
      if (Math.abs(vL - newVL) > maxDelta) newVL = vL - sign(vL) * maxDelta;
      const scrub = Math.abs(vL) - Math.abs(newVL);
      if (this.drifting && vF > 0) vF += scrub * CAR.driftSpeedKeep;
      vL = newVL;
    }

    this.longAccel += ((vF - this.forwardSpeed) / dt - this.longAccel) * damp(6, dt);
    this.latAccel += (vF * this.yawRate - this.latAccel) * damp(6, dt);

    this.vx = fx * vF + rx * vL;
    this.vz = fz * vF + rz * vL;
    // angular velocity of the velocity vector itself (used by the drift controller)
    const velAngle = Math.atan2(-this.vx, -this.vz);
    if (this.speed > 2) {
      let dA = velAngle - this.velAngle;
      if (dA > Math.PI) dA -= Math.PI * 2;
      if (dA < -Math.PI) dA += Math.PI * 2;
      this.velTurnRate += (dA / dt - this.velTurnRate) * damp(20, dt);
    } else this.velTurnRate = 0;
    this.velAngle = velAngle;
    this.heading += this.yawRate * dt;
    this.forwardSpeed = vF;
    this.lateralSpeed = vL;
    this.speed = Math.hypot(vF, vL);
    this.slip = this.speed > 3 ? Math.atan2(Math.abs(vL), Math.abs(vF)) : 0;
    this.wheelSpin += (vF * dt) / 0.34;

    // ---------------------------------------------------------------- integrate planar + walls
    this.pos.x += this.vx * dt;
    this.pos.z += this.vz * dt;
    this.collideWalls(track.walls);

    // ---------------------------------------------------------------- vertical
    const G = CAR.gravity;
    const has = track.sampleGround(this.pos.x, this.pos.y, this.pos.z, g);
    if (has) {
      if (this.grounded) {
        const ballistic = this.pos.y + this.vy * dt - 0.5 * G * dt * dt;
        if (g.y < ballistic - 0.03) {
          this.grounded = false;
          this.pos.y = ballistic;
          this.vy -= G * dt;
        } else {
          this.vy = clamp((g.y - this.pos.y) / dt, -15, 15);
          this.pos.y = g.y;
        }
      } else {
        this.vy -= G * dt;
        this.pos.y += this.vy * dt;
        if (this.pos.y <= g.y) {
          this.landing = Math.max(this.landing, -this.vy);
          this.pos.y = g.y;
          this.vy = 0;
          this.grounded = true;
        }
      }
      this.up.x += (g.nx - this.up.x) * damp(10, dt);
      this.up.y += (g.ny - this.up.y) * damp(10, dt);
      this.up.z += (g.nz - this.up.z) * damp(10, dt);
      this.up.normalize();
    } else if (this.grounded) {
      // Tiny gaps between collider meshes (e.g. at the foot of a barrier): keep the last
      // ground height instead of dropping through. g.surface is 'none' -> counts as off-track.
      this.vy = 0;
    } else {
      this.vy -= G * dt;
      this.pos.y += this.vy * dt;
    }

    this.updateGearbox(dt, c);
  }

  private updateGearbox(dt: number, c: Controls): void {
    // wheel speed ~ forward speed, but while sliding the driven wheels spin up: use the larger
    const v = Math.max(Math.abs(this.forwardSpeed), this.forwardSpeed > 0 ? this.speed * 0.95 : 0);
    const gears = CAR.gears;
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    if (this.forwardSpeed < -0.5) {
      this.gear = 0; // reverse
    } else {
      if (this.gear < 1) this.gear = 1;
      if (this.gear < gears.length - 1 && v > gears[this.gear] * 0.97) {
        this.gear++;
        this.shiftTimer = CAR.shiftTime;
        this.shiftedUp = true;
      } else if (this.gear > 1 && v < gears[this.gear - 1] * 0.78) {
        this.gear--;
      }
    }
    const top = this.gear === 0 ? CAR.reverseMax : gears[Math.max(1, this.gear)];
    let target = (v / top) * CAR.redline;
    const minRpm = CAR.idleRpm + (this.gear <= 1 ? c.throttle * 2200 : 0);
    if (!this.grounded) target = CAR.idleRpm + c.throttle * 6000; // free revving in the air
    target = clamp(Math.max(target, minRpm), CAR.idleRpm, CAR.redline * 1.02);
    if (this.shiftTimer > 0) target *= 0.92;
    this.rpm += (target - this.rpm) * damp(this.shiftedUp ? 30 : 14, dt);
  }

  /** Re-run wall resolution after an external push (car-car contact) moved us from (x0, z0). */
  resolveWallsAfterPush(walls: WallGrid, x0: number, z0: number): void {
    this.px = x0;
    this.pz = z0;
    this.pHeading = this.heading;
    this.collideWalls(walls);
  }

  /**
   * Circle-vs-segment wall response with a swept pre-pass on every circle centre,
   * so even a 300 km/h impact during a dt spike cannot cross a wall.
   */
  private collideWalls(walls: WallGrid): void {
    const r = CAR.circleRadius;
    const offs = CAR.circleOffsets;
    const n = { x: 0, z: 0 };
    // --- swept test (centres of all circles, previous step -> now)
    const pfx = -Math.sin(this.pHeading);
    const pfz = -Math.cos(this.pHeading);
    for (let iter = 0; iter < 2; iter++) {
      const fx = this.fx;
      const fz = this.fz;
      let hitT = -1;
      for (let i = 0; i < offs.length; i++) {
        const o = offs[i];
        const x0 = this.px - pfx * o;
        const z0 = this.pz - pfz * o;
        const x1 = this.pos.x - fx * o;
        const z1 = this.pos.z - fz * o;
        const t = walls.sweep(x0, z0, x1, z1, n);
        if (t >= 0 && (hitT < 0 || t < hitT)) hitT = t;
      }
      if (hitT < 0) break;
      // Rewind to just before the crossing; the penetration pass below handles the response.
      const back = Math.max(0, hitT - 0.02);
      this.pos.x = this.px + (this.pos.x - this.px) * back + n.x * 0.05;
      this.pos.z = this.pz + (this.pos.z - this.pz) * back + n.z * 0.05;
    }

    // --- penetration resolution
    for (let pass = 0; pass < 2; pass++) {
      let any = false;
      const fx = this.fx;
      const fz = this.fz;
      for (let i = 0; i < offs.length; i++) {
        const o = offs[i];
        const cx = this.pos.x - fx * o;
        const cz = this.pos.z - fz * o;
        const list = walls.query(cx - r, cz - r, cx + r, cz + r);
        let bestPen = 0;
        let bnx = 0;
        let bnz = 0;
        for (let k = 0; k < list.length; k++) {
          const s = list[k] * 4;
          const ax = walls.seg[s];
          const az = walls.seg[s + 1];
          const ex = walls.seg[s + 2] - ax;
          const ez = walls.seg[s + 3] - az;
          const l2 = ex * ex + ez * ez;
          let t = ((cx - ax) * ex + (cz - az) * ez) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + ex * t;
          const qz = az + ez * t;
          const dx = cx - qx;
          const dz = cz - qz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;
          const d = Math.sqrt(d2);
          const pen = r - d;
          if (pen > bestPen) {
            bestPen = pen;
            if (d > 1e-5) {
              bnx = dx / d;
              bnz = dz / d;
            } else {
              const l = Math.sqrt(l2);
              bnx = -ez / l;
              bnz = ex / l;
              if (bnx * (this.px - cx) + bnz * (this.pz - cz) < 0) {
                bnx = -bnx;
                bnz = -bnz;
              }
            }
          }
        }
        if (bestPen > 0) {
          any = true;
          this.pos.x += bnx * bestPen;
          this.pos.z += bnz * bestPen;
          this.applyContactImpulse(cx - bnx * r, cz - bnz * r, bnx, bnz, WALL.restitution, WALL.friction, 0);
        }
      }
      if (!any) break;
    }
  }

  /**
   * Impulse at a world contact point (XZ) against an immovable surface with normal n.
   * `otherInvMass` lets car-car contacts reuse the formula (0 = static wall).
   * Returns the normal impulse magnitude divided by mass (delta-v).
   */
  applyContactImpulse(
    cx: number,
    cz: number,
    nx: number,
    nz: number,
    restitution: number,
    friction: number,
    otherVx: number,
    otherVz = 0,
    massScale = 1,
  ): number {
    const rX = cx - this.pos.x;
    const rZ = cz - this.pos.z;
    // velocity of the contact point: v + w x r, with w = (0, yawRate, 0)
    const w = this.yawRate;
    const vcx = this.vx + w * rZ - otherVx;
    const vcz = this.vz - w * rX - otherVz;
    const vn = vcx * nx + vcz * nz;
    if (vn >= 0) return 0;
    const rCrossN = rZ * nx - rX * nz;
    const angScale = WALL.angularScale;
    const denom = INV_MASS * massScale + rCrossN * rCrossN * INV_INERTIA * angScale;
    const j = (-(1 + restitution) * vn) / denom;
    this.vx += nx * j * INV_MASS * massScale;
    this.vz += nz * j * INV_MASS * massScale;
    this.yawRate += rCrossN * j * INV_INERTIA * angScale;
    // tangential friction (scrubs speed along the wall), capped by Coulomb
    const tx = -nz;
    const tz = nx;
    const vt = vcx * tx + vcz * tz;
    const jtMax = friction * j;
    let jt = -vt / (INV_MASS * massScale);
    jt = clamp(jt, -jtMax, jtMax);
    this.vx += tx * jt * INV_MASS * massScale;
    this.vz += tz * jt * INV_MASS * massScale;
    const dv = j * INV_MASS * massScale;
    if (dv > this.impact) {
      this.impact = dv;
      this.impactX = cx;
      this.impactZ = cz;
    }
    // a hard hit breaks a drift
    if (dv > 6) this.drifting = false;
    return dv;
  }

  /** Is the car's local up pointing away from the world up (rolled/flipped)? */
  get upsideDown(): boolean {
    return this.up.y < 0.3;
  }
}
