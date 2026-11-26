/**
 * One car: Bloom's Jolt wheeled vehicle (suspension, tyres, engine, automatic gearbox) plus
 * arcade assists applied as forces every fixed step: speed limiter + drag, downforce, yaw
 * assist, a drift model on the handbrake, lateral grip assist, nitro thrust and off-road drag.
 *
 * Pure physics: no three.js here. sync.ts reads `state` and copies it to the scene.
 */
import * as P from "@bloomengine/engine/physics";
import { PhysicsWorld, Surface, FIXED_DT } from "./world.ts";

export interface Controls {
  throttle: number;   // 0..1
  brake: number;      // 0..1 (brake, then reverse when stopped)
  steer: number;      // -1 (left) .. 1 (right)
  handbrake: boolean;
  nitro: boolean;
}

export function noControls(): Controls { return { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false }; }

export interface CarTuning {
  topSpeed: number;       // m/s without nitro
  nitroSpeed: number;     // m/s with nitro
  engineTorque: number;   // Nm
  nitroForce: number;     // N
  grip: number;           // lateral grip assist (1/s)
}


/**
 * Handling constants. RACER_TUNE='{"grip":3,...}' overrides any of them at launch, so the
 * handling can be tuned without a rebuild.
 */
export const TUNE = {
  chassisFriction: 1.0,   // Jolt combines tyre grip with the chassis body's friction: keep it high
  accelAssist: 10000,      // N of arcade push under throttle, fading towards top speed
  drag: 0.36,             // aero drag coefficient (N per (m/s)^2)
  downforce: 1.6,         // N per (m/s)^2
  grip: 3.2,              // lateral grip assist (1/s)
  driftGrip: 0.3,         // fraction of grip kept in a drift (velocity follows the nose)
  latAccel: 13, driftLatAccel: 16,   // m/s²: yaw rate the stick asks for is what the tyres can carve
  driftExtraYaw: 0.7,     // rad/s of extra rotation in a drift (opens the angle up to maxSlip)
  yawGain: 2.8, driftYawGain: 5.5, driftYawBoost: 1.0,
  driftPush: 2200,
  handbrakeInput: 0.2,    // how hard Jolt's handbrake bites (locked rears lose all side grip)
  maxSlip: 0.55,          // rad: the drift angle is held below this (~32°)
  slipCorrect: 14,        // strength of the slip cap
  steerSpeed: 900,        // steering narrows as 1/(1+v^2/steerSpeed)
  brakeTorque: 3500, handbrakeTorque: 3000,
  engineTorque: 950,
};
try {
  const env = process.env["RACER_TUNE"];
  if (env !== undefined && env !== "") Object.assign(TUNE, JSON.parse(env) as Partial<typeof TUNE>);
} catch { /* ignore bad tuning */ }

export const PLAYER_TUNING: CarTuning = { topSpeed: 250 / 3.6, nitroSpeed: 300 / 3.6, engineTorque: TUNE.engineTorque, nitroForce: 15000, grip: TUNE.grip };

export const MASS = 1500; // fixed by Bloom's vehicle shim
const WHEEL_RADIUS = 0.34;
const SUSP_MIN = 0.05, SUSP_MAX = 0.32;
const ATTACH_Y = 0.34 + 0.2;   // wheel centre at ~0.34 m under static load
const MAX_STEER = 0.55;        // rad at standstill
/** Jolt's default WheeledVehicleController gearbox and differential (the shim doesn't change them). */
const GEARS = [2.66, 1.78, 1.3, 1.0, 0.74];
const DIFF_RATIO = 3.42;

export interface CarState {
  pos: P.Vec3; rot: P.Quat;
  vel: P.Vec3;
  speed: number;          // m/s, signed along forward
  forward: P.Vec3; up: P.Vec3; right: P.Vec3;
  rpm: number; gear: number;
  slipAngle: number;      // rad, sideways slide
  drifting: boolean;
  nitroActive: boolean;
  surface: Surface;       // what is under the car
  airborne: boolean;
  wheelPos: P.Vec3[];     // world-space wheel centres (suspension travel)
  wheelSpin: number[];    // accumulated spin angle (rad)
  steerAngle: number;     // visual front-wheel angle (rad, + = left)
  braking: boolean;
}

function rotate(q: P.Quat, v: P.Vec3): P.Vec3 {
  // v' = q v q*
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}
function dot(a: P.Vec3, b: P.Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }

/**
 * Bloom's vehicle shim leaves Jolt's per-wheel forward at +Z (VehicleConfig.forward only feeds the
 * constraint), so the physics body faces +Z while the car model faces -Z. The body frame is the
 * model frame turned 180° about Y; these convert at the boundary so the rest of the game only
 * ever sees the model frame.
 */
function flipY(q: P.Quat): P.Quat {  // q * (0,1,0,0)
  return { x: -q.z, y: q.w, z: q.x, w: -q.y };
}

/** Volume centroid of a closed triangle mesh (for the centre-of-mass offset). */
function centroid(pts: P.Vec3[], idx: number[]): P.Vec3 {
  let vol = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = pts[idx[i]!]!, b = pts[idx[i + 1]!]!, c = pts[idx[i + 2]!]!;
    const v = (a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x)) / 6;
    vol += v; cx += v * (a.x + b.x + c.x) / 4; cy += v * (a.y + b.y + c.y) / 4; cz += v * (a.z + b.z + c.z) / 4;
  }
  if (Math.abs(vol) < 1e-6) return { x: 0, y: 0.6, z: 0 };
  return { x: cx / vol, y: cy / vol, z: cz / vol };
}

export interface ChassisShape { shape: P.ShapeHandle }

/** Build the chassis shape once from the car's hidden convex collider; every car shares it. */
export function makeChassisShape(hullPositions: number[], hullIndices: number[]): ChassisShape {
  const pts: P.Vec3[] = [];
  // into the body frame (model turned 180° about Y)
  for (let i = 0; i < hullPositions.length; i += 3) pts.push({ x: -hullPositions[i]!, y: hullPositions[i + 1]!, z: -hullPositions[i + 2]! });
  const hull = P.convexHullShape(pts, 0.04);
  const c = centroid(pts, hullIndices);
  // a lower centre of mass than the real car's (0.46 m): arcade-stable, hard to roll
  const target = { x: 0, y: 0.36, z: 0.08 };   // model (0, 0.36, -0.08) in the body frame
  const shape = P.offsetCenterOfMassShape(hull, { x: target.x - c.x, y: target.y - c.y, z: target.z - c.z });
  return { shape };
}

export class Vehicle {
  readonly handle: P.VehicleHandle;
  readonly body: P.BodyHandle;
  readonly tuning: CarTuning;
  controls: Controls = noControls();
  readonly state: CarState;
  /** previous-step pose, for render interpolation (sync.ts) and the anti-tunnel guard */
  prevPos: P.Vec3 = { x: 0, y: 0, z: 0 };
  prevRot: P.Quat = { x: 0, y: 0, z: 0, w: 1 };
  private steerSmoothed = 0;
  private driftTimer = 0;
  private groundTimer = 0;
  tunnelSaves = 0;

  constructor(private readonly phys: PhysicsWorld, chassis: ChassisShape, pos: P.Vec3, rot: P.Quat, tuning: CarTuning) {
    this.tuning = tuning;
    const w = 0.83, l = 1.35;
    this.handle = P.createVehicle(phys.world, {
      chassisShape: chassis.shape,
      position: { x: pos.x, y: pos.y + 0.05, z: pos.z }, rotation: flipY(rot),
      up: { x: 0, y: 1, z: 0 },
      forward: { x: 0, y: 0, z: 1 },
      // FL, FR, RL, RR in the body frame (front = +Z, left = +X), relative to the body origin
      wheelPositions: [
        { x: w, y: ATTACH_Y, z: l }, { x: -w, y: ATTACH_Y, z: l },
        { x: w, y: ATTACH_Y, z: -l }, { x: -w, y: ATTACH_Y, z: -l },
      ],
      wheelRadius: WHEEL_RADIUS, wheelWidth: 0.255,
      suspensionMinLength: SUSP_MIN, suspensionMaxLength: SUSP_MAX,
      maxSteerAngleRad: MAX_STEER,
      maxBrakeTorque: TUNE.brakeTorque, maxHandbrakeTorque: TUNE.handbrakeTorque,
      engineMaxTorque: tuning.engineTorque,
      maxPitchRollAngleRad: 0.9,
    });
    this.body = P.getVehicleChassis(this.handle);
    P.setBodyCcd(this.body, true);           // linear-cast motion: no tunnelling at 300 km/h
    P.setFriction(this.body, TUNE.chassisFriction);   // also the tyres' grip (Jolt combines them)
    P.setRestitution(this.body, 0.15);
    P.setAngularDamping(this.body, 0.6);
    P.setAllowSleeping(this.body, false);
    this.phys.tagBody(this.body, Surface.Car);
    this.state = {
      pos: { ...pos }, rot: { ...rot }, vel: { x: 0, y: 0, z: 0 }, speed: 0,
      forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 }, right: { x: 1, y: 0, z: 0 },
      rpm: 1000, gear: 1, slipAngle: 0, drifting: false, nitroActive: false,
      surface: Surface.Road, airborne: false,
      wheelPos: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }],
      wheelSpin: [0, 0, 0, 0], steerAngle: 0, braking: false,
    };
    this.readState();
    this.prevPos = { ...this.state.pos }; this.prevRot = { ...this.state.rot };
  }

  /** Put the car somewhere, at rest (resets, restarts). */
  teleport(pos: P.Vec3, rot: P.Quat): void {
    P.setBodyTransform(this.body, { position: { x: pos.x, y: pos.y + 0.15, z: pos.z }, rotation: flipY(rot) });
    P.setLinearVelocity(this.body, { x: 0, y: 0, z: 0 });
    P.setAngularVelocity(this.body, { x: 0, y: 0, z: 0 });
    this.steerSmoothed = 0; this.driftTimer = 0;
    this.readState();
    this.prevPos = { ...this.state.pos }; this.prevRot = { ...this.state.rot };
  }

  /** Before each fixed step: driver input to Jolt, then the arcade forces. */
  preStep(h: number, frozen: boolean): void {
    const c = this.controls, s = this.state;
    const fwdSpeed = s.speed;
    const absSpeed = Math.abs(fwdSpeed);
    this.prevPos = { ...s.pos }; this.prevRot = { ...s.rot };

    if (frozen) {
      // countdown: engine revs, brakes held
      P.setVehicleInput(this.handle, 0, 0, 1, 1);
      return;
    }

    // -- steering: smoothed, narrower at speed (stable at 250 km/h, agile in the hairpin)
    const speedFactor = 1 / (1 + absSpeed * absSpeed / TUNE.steerSpeed);
    const target = c.steer * Math.max(0.16, speedFactor);
    const rate = (Math.abs(target) < Math.abs(this.steerSmoothed) ? 7 : 4) * h;
    this.steerSmoothed += Math.max(-rate, Math.min(rate, target - this.steerSmoothed));

    // -- throttle / brake / reverse
    let forward = c.throttle, brake = 0;
    if (c.brake > 0) {
      if (fwdSpeed > 1.5) { brake = c.brake; forward = c.throttle * 0.2; }
      else { forward = -c.brake * 0.6; }     // reverse
    }
    const vmax = this.nitroOn() ? this.tuning.nitroSpeed : this.tuning.topSpeed;
    if (fwdSpeed > vmax - 4) forward *= Math.max(0, (vmax - fwdSpeed) / 4);   // soft limiter
    const hb = c.handbrake && absSpeed > 3 ? 1 : 0;
    P.setVehicleInput(this.handle, forward, this.steerSmoothed, brake, hb * TUNE.handbrakeInput);
    s.braking = brake > 0.1;

    // -- arcade forces
    const m = MASS;
    const up = s.up, f = s.forward, r = s.right, v = s.vel;
    const vLat = dot(v, r);
    const grounded = !s.airborne;

    // aero drag + rolling resistance (more off-road)
    // + over the top speed (downhill, after nitro): bleed it off firmly
    const vLen = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (vLen > 0.5) {
      const dragMag = TUNE.drag * vLen * vLen
        + (s.surface === Surface.Terrain ? 2600 * Math.min(1, vLen / 5) : 0)
        + Math.max(0, fwdSpeed - vmax) * m * 0.8;
      const k = -dragMag / vLen;
      P.addForce(this.body, { x: v.x * k, y: 0, z: v.z * k });
    }

    if (grounded) {
      // downforce: more grip at speed
      const down = TUNE.downforce * absSpeed * absSpeed;
      P.addForce(this.body, { x: -up.x * down, y: -up.y * down, z: -up.z * down });

      // drift state: handbrake at speed starts it; it holds while steering and sliding
      const slide = Math.abs(s.slipAngle);
      if (c.handbrake && absSpeed > 12) this.driftTimer = 0.35;
      else if (slide > 0.18 && Math.abs(c.steer) > 0.3 && absSpeed > 12) this.driftTimer = Math.max(this.driftTimer, 0.12);
      else this.driftTimer = Math.max(0, this.driftTimer - h);
      const drifting = this.driftTimer > 0;
      s.drifting = drifting && slide > 0.12;

      // lateral grip assist: kill sideways speed (weaker while drifting, so the tail can swing)
      const grip = drifting ? this.tuning.grip * TUNE.driftGrip : this.tuning.grip * (s.surface === Surface.Terrain ? 0.5 : 1);
      const lat = -vLat * m * grip;
      P.addForce(this.body, { x: r.x * lat, y: r.y * lat, z: r.z * lat });

      // yaw assist: turn rate follows the stick, more eagerly in a drift
      const av = P.getAngularVelocity(this.body);
      const yaw = dot(av, up);
      const sign = fwdSpeed >= 0 ? 1 : -1;
      const carve = drifting ? TUNE.driftLatAccel / Math.max(absSpeed, 6) + TUNE.driftExtraYaw : TUNE.latAccel / Math.max(absSpeed, 6) + 0.1;
      const desired = -c.steer * sign * Math.min(absSpeed / 8, 1) * Math.min(2.2, carve * (drifting ? TUNE.driftYawBoost : 1.0));
      const yawGain = drifting ? TUNE.driftYawGain : TUNE.yawGain;
      const inertia = 2600;   // ~ yaw inertia of a 1.5 t car (kg m²)
      const tq = (desired - yaw) * yawGain * inertia * Math.min(1, absSpeed / 4);
      P.addTorque(this.body, { x: up.x * tq, y: up.y * tq, z: up.z * tq });
      // drift keeps its speed (arcade): push along the velocity a little
      if (drifting && c.throttle > 0.5 && absSpeed < vmax) {
        const push = TUNE.driftPush;
        P.addForce(this.body, { x: f.x * push, y: f.y * push, z: f.z * push });
      }
      // hold the slide under maxSlip so a drift never turns into a spin: pull the velocity
      // towards the nose and stop the nose rotating further away from the velocity
      if (slide > TUNE.maxSlip && absSpeed > 5) {
        const excess = slide - TUNE.maxSlip;
        const corr = -Math.sign(vLat) * excess * m * TUNE.slipCorrect;
        P.addForce(this.body, { x: r.x * corr, y: r.y * corr, z: r.z * corr });
        // sliding right (vLat > 0) with the nose yawing left (yaw > 0) grows the slip, and vice versa
        if (Math.sign(vLat) * yaw > 0) {
          const t2 = -yaw * inertia * 8 * Math.min(1, excess * 4);
          P.addTorque(this.body, { x: up.x * t2, y: up.y * t2, z: up.z * t2 });
        }
      }
    } else {
      s.drifting = false;
      // in the air: level out gently
      const av = P.getAngularVelocity(this.body);
      P.addTorque(this.body, { x: -av.x * 1500 + (up.z) * 3000, y: 0, z: -av.z * 1500 - (up.x) * 3000 });
    }

    // arcade acceleration: a push under throttle on top of the Jolt drivetrain
    if (grounded && forward > 0 && fwdSpeed > -1 && fwdSpeed < vmax) {
      const k = forward * TUNE.accelAssist * Math.sqrt(Math.max(0, 1 - fwdSpeed / vmax));
      P.addForce(this.body, { x: f.x * k, y: f.y * k, z: f.z * k });
    }

    // nitro thrust
    s.nitroActive = this.nitroOn();
    if (s.nitroActive && fwdSpeed < vmax) {
      const k = this.tuning.nitroForce;
      P.addForce(this.body, { x: f.x * k, y: f.y * k, z: f.z * k });
    }
  }

  private nitroOn(): boolean { return this.controls.nitro; }

  /** After each fixed step: read the new state; guard against tunnelling. */
  postStep(): void {
    const before = this.prevPos;
    this.readState();
    if (this.phys.wallBetween({ x: before.x, y: before.y + 0.6, z: before.z }, { x: this.state.pos.x, y: this.state.pos.y + 0.6, z: this.state.pos.z })) {
      // the solver let the car through a wall: put it back and kill the speed into the wall
      this.tunnelSaves++;
      const v = this.state.vel;
      P.setBodyTransform(this.body, { position: before, rotation: flipY(this.prevRot) });
      P.setLinearVelocity(this.body, { x: -v.x * 0.2, y: v.y, z: -v.z * 0.2 });
      this.readState();
    }
  }

  readState(): void {
    const s = this.state;
    const t = P.getBodyTransform(this.body);
    s.pos = t.position; s.rot = flipY(t.rotation);   // back to the model frame
    s.vel = P.getLinearVelocity(this.body);
    s.forward = rotate(s.rot, { x: 0, y: 0, z: -1 });
    s.up = rotate(s.rot, { x: 0, y: 1, z: 0 });
    s.right = rotate(s.rot, { x: 1, y: 0, z: 0 });
    s.speed = dot(s.vel, s.forward);
    const lat = dot(s.vel, s.right);
    s.slipAngle = Math.abs(s.speed) > 2 ? Math.atan2(lat, Math.abs(s.speed)) : 0;

    // ground probe from the car's centre: surface type and airborne
    const g = this.phys.probe(s.pos.x + s.up.x * 0.8, s.pos.y + s.up.y * 0.8, s.pos.z + s.up.z * 0.8, 2.2);
    if (g.distance < 1.6) { this.groundTimer = 0; s.surface = g.surface; }
    else { this.groundTimer += FIXED_DT; if (g.distance === Infinity) s.surface = Surface.None; }
    s.airborne = this.groundTimer > 0.15;

    s.rpm = P.getVehicleEngineRPM(this.handle);
    // the shim doesn't expose the gear: infer it from engine rpm vs driven-wheel rpm
    const wheelRadS = Math.abs((P.getWheelAngularVelocity(this.handle, 2) + P.getWheelAngularVelocity(this.handle, 3)) / 2);
    if (wheelRadS > 3) {
      const engineRadS = s.rpm * Math.PI / 30;
      const ratio = engineRadS / (wheelRadS * DIFF_RATIO);
      let best = 1, bestErr = Infinity;
      for (let i = 0; i < GEARS.length; i++) { const e = Math.abs(GEARS[i]! - ratio); if (e < bestErr) { bestErr = e; best = i + 1; } }
      s.gear = s.speed < -0.5 ? 0 : best;
    } else s.gear = s.speed < -0.5 ? 0 : 1;

    for (let i = 0; i < 4; i++) {
      const wt = P.getWheelTransform(this.handle, i);
      s.wheelPos[i] = wt.position;
      s.wheelSpin[i] = (s.wheelSpin[i]! + P.getWheelAngularVelocity(this.handle, i) * FIXED_DT) % (Math.PI * 2);
    }
    s.steerAngle = -this.steerSmoothed * MAX_STEER;
  }
}
