// Arcade vehicle: a Jolt rigid-body chassis with raycast suspension and
// game-tuned tyre/drive forces (not Jolt's WheeledVehicle — we need full
// control over drift, nitro and top speed). Also owns the car's visuals.
import * as physics from "bloom/physics";
import { loadModel } from "bloom/models";
import { Model } from "bloom/core";
import { loadTexture } from "bloom/textures";
import {
  createSceneNode, attachModelToNode, setSceneNodeTransform,
  setSceneNodeMaterialTextureHandles,
} from "bloom/scene";
import {
  V3, Q4, qRotate, clampN, lerpN, mat4FromQT, mat4Mul, newMat4, qNlerp, moveTowards,
} from "./util/math3d";
import * as C from "./config";
import { setNodeMaterial } from "./material";
import * as fast from "./physfast";
import { CAR_VARIANT_TEXTURES } from "./generated/trackData";

export interface DriveInput {
  throttle: number;  // 0..1
  brake: number;     // 0..1 (also reverse when stopped)
  steer: number;     // -1..1, + = right
  handbrake: boolean;
  nitro: boolean;
}

export function emptyInput(): DriveInput {
  return { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false };
}

// Wheel order: FL, FR, RL, RR (car forward = -Z, right = +X).
const WX: number[] = [-C.WHEEL_X, C.WHEEL_X, -C.WHEEL_X, C.WHEEL_X];
const WZ: number[] = [-C.WHEEL_Z, -C.WHEEL_Z, C.WHEEL_Z, C.WHEEL_Z];
const HARDPOINT_Y = C.WHEEL_RADIUS + 0.3;     // suspension top (car local)
const GRAVITY = 9.81;
const SUSP_FREQ = 1.7;                         // Hz
const SUSP_ZETA = 0.5;
const STATIC_COMPRESSION = GRAVITY / ((2 * Math.PI * SUSP_FREQ) * (2 * Math.PI * SUSP_FREQ));
const REST_LEN = 0.3 + STATIC_COMPRESSION;     // wheel centre sits at y=0.34 at rest
const RAY_LEN = REST_LEN + C.WHEEL_RADIUS;

// Model primitive indices in car.glb (see NOTES.md): body 0..4, wheels
// FR 5..7, RR 8..10, FL 11..13, RL 14..16, brake lights 17, collider 18.
const PRIM_PAINT = 0;
const PRIM_BRAKE = 17;
const WHEEL_PRIM_START: number[] = [11, 5, 14, 8]; // FL, FR, RL, RR

let carModel: Model | null = null;
const paintTex: number[] = [0, 0, 0, 0];

export function loadCarAssets(): void {
  carModel = loadModel("assets/cars/car.glb");
  for (let i = 0; i < 4; i++) paintTex[i] = loadTexture(CAR_VARIANT_TEXTURES[i]).handle;
}

let chassisShape = 0;
function getChassisShape(): number {
  if (chassisShape !== 0) return chassisShape;
  const box = physics.boxShape({ x: 0.95, y: 0.36, z: 2.2 }, 0.08);
  const compound = physics.compoundShape([
    { shape: box, local: { position: { x: 0, y: 0.72, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } },
  ]);
  // Box centre is at y=0.72; pull the centre of mass down/forward to ~(0,0.38,-0.08).
  chassisShape = physics.offsetCenterOfMassShape(compound, { x: 0, y: -0.34, z: C.COM_Z });
  return chassisShape;
}

const tmpA: V3 = { x: 0, y: 0, z: 0 };
// Scratch for the per-step physics reads (see physfast.ts: no per-call objects).
const tmpP: V3 = { x: 0, y: 0, z: 0 };
const tmpV: V3 = { x: 0, y: 0, z: 0 };
const tmpW: V3 = { x: 0, y: 0, z: 0 };
const tmpQ: Q4 = { x: 0, y: 0, z: 0, w: 1 };

export class Car {
  readonly index: number;
  readonly isPlayer: boolean;
  readonly world: number;
  body = 0;
  mass = C.CAR_MASS;
  // --- simulation state (raw, latest physics step) ---
  pos: V3 = { x: 0, y: 0, z: 0 };
  rot: Q4 = { x: 0, y: 0, z: 0, w: 1 };
  vel: V3 = { x: 0, y: 0, z: 0 };
  fwd: V3 = { x: 0, y: 0, z: -1 };
  right: V3 = { x: 1, y: 0, z: 0 };
  up: V3 = { x: 0, y: 1, z: 0 };
  prevPos: V3 = { x: 0, y: 0, z: 0 };
  prevRot: Q4 = { x: 0, y: 0, z: 0, w: 1 };
  speed = 0;          // forward speed m/s (signed)
  steerAngle = 0;     // rad, + = right
  input: DriveInput = emptyInput();
  grounded = 0;       // wheels touching anything
  onRoad = 0;         // wheels touching col_road
  wheelCompression: number[] = [0, 0, 0, 0];
  wheelSpin: number[] = [0, 0, 0, 0];
  gear = 1;
  rpm = C.IDLE_RPM;
  shiftTimer = 0;
  justShifted = false;
  shiftCount = 0;
  nitro = C.NITRO_START;
  nitroActive = false;
  drifting = false;
  driftAmount = 0;    // 0..1 for audio/fx
  slipAngle = 0;
  braking = false;
  impact = 0;         // strongest impact (delta-v m/s) in the last step
  // --- race state (managed by race.ts) ---
  nextCp = 0;
  lastCp = 0;
  cpTotal = 0;
  lap = 0;
  finished = false;
  finishTime = 0;
  lapStart = 0;
  lastLapTime = 0;
  bestLapTime = 0;
  lapTimes: number[] = [];
  lineIdx = -1;
  offTrackTimer = 0;
  flipTimer = 0;
  draftTimer = 0;
  started = false;
  position = 1;
  // --- visuals ---
  private nodes: number[] = [];
  private brakeLit = false;
  private m4car = newMat4();
  private m4a = newMat4();
  private m4b = newMat4();
  private renderRot: Q4 = { x: 0, y: 0, z: 0, w: 1 };

  constructor(world: number, index: number, variant: number, isPlayer: boolean) {
    this.world = world;
    this.index = index;
    this.isPlayer = isPlayer;
    this.createVisuals(variant);
  }

  private createVisuals(variant: number): void {
    const model = carModel;
    if (model === null) return;
    // Push through a local alias: Perry's wasm target (0.5.1664) drops
    // `this.field.push(x)` (the array stays empty in the browser build).
    const nodes = this.nodes;
    for (let i = 0; i < 18; i++) {
      const n = createSceneNode();
      attachModelToNode(n, model.handle, i);
      nodes.push(n);
    }
    if (variant !== 0 && paintTex[variant] !== 0) {
      setSceneNodeMaterialTextureHandles(this.nodes[PRIM_PAINT], { baseColor: paintTex[variant] });
    }
    this.setBrakeLights(false);
  }

  private setBrakeLights(on: boolean): void {
    this.brakeLit = on;
    if (on) {
      setNodeMaterial(this.nodes[PRIM_BRAKE], 190, 10, 10, 0.15, 0, 4.0, 0.16, 0.08);
    } else {
      setNodeMaterial(this.nodes[PRIM_BRAKE], 115, 5, 5, 0.15, 0, 0.35, 0.01, 0.005);
    }
  }

  spawn(p: V3, q: Q4): void {
    if (this.body === 0) {
      this.body = physics.createBody(this.world, getChassisShape(), {
        motionType: physics.MotionType.DYNAMIC,
        position: { x: p.x, y: p.y + 0.05, z: p.z },
        rotation: q,
        objectLayer: physics.Layer.MOVING,
        friction: 0.15,
        restitution: 0.05,
        linearDamping: 0.0,
        angularDamping: 0.6,
        useCcd: true,
        allowSleeping: false,
      });
      this.mass = physics.getBodyMass(this.body);
    } else {
      physics.setBodyTransform(this.body, { position: { x: p.x, y: p.y + 0.05, z: p.z }, rotation: q }, true);
    }
    physics.setLinearVelocity(this.body, { x: 0, y: 0, z: 0 });
    physics.setAngularVelocity(this.body, { x: 0, y: 0, z: 0 });
    this.pos.x = p.x; this.pos.y = p.y; this.pos.z = p.z;
    this.rot.x = q.x; this.rot.y = q.y; this.rot.z = q.z; this.rot.w = q.w;
    this.prevPos.x = p.x; this.prevPos.y = p.y; this.prevPos.z = p.z;
    this.prevRot.x = q.x; this.prevRot.y = q.y; this.prevRot.z = q.z; this.prevRot.w = q.w;
    this.vel.x = 0; this.vel.y = 0; this.vel.z = 0;
    this.speed = 0;
    this.steerAngle = 0;
    this.nitroActive = false;
    this.drifting = false;
    this.offTrackTimer = 0;
    this.flipTimer = 0;
    this.updateAxes();
  }

  private updateAxes(): void {
    qRotate(this.rot, 0, 0, -1, this.fwd);
    qRotate(this.rot, 1, 0, 0, this.right);
    qRotate(this.rot, 0, 1, 0, this.up);
  }

  /** Read the body's state after a physics step. */
  readState(): void {
    this.prevPos.x = this.pos.x; this.prevPos.y = this.pos.y; this.prevPos.z = this.pos.z;
    this.prevRot.x = this.rot.x; this.prevRot.y = this.rot.y; this.prevRot.z = this.rot.z; this.prevRot.w = this.rot.w;
    const p = tmpP, q = tmpQ, v = tmpV;
    fast.bodyPosition(this.body, p);
    fast.bodyRotation(this.body, q);
    fast.bodyLinearVelocity(this.body, v);
    // Impact detection: horizontal velocity change beyond what our own forces explain.
    const dvx = v.x - this.vel.x, dvz = v.z - this.vel.z;
    const dv = Math.sqrt(dvx * dvx + dvz * dvz);
    this.impact = 0;
    if (dv > 1.8) this.impact = dv;
    this.pos.x = p.x; this.pos.y = p.y; this.pos.z = p.z;
    this.rot.x = q.x; this.rot.y = q.y; this.rot.z = q.z; this.rot.w = q.w;
    this.vel.x = v.x; this.vel.y = v.y; this.vel.z = v.z;
    this.updateAxes();
    this.speed = v.x * this.fwd.x + v.y * this.fwd.y + v.z * this.fwd.z;
  }

  /** Apply suspension, tyre and drive forces for one fixed step. */
  applyForces(dt: number, trackRoad: number, trackTerrain: number): void {
    const inp = this.input;
    const m = this.mass;
    const absSpeed = Math.abs(this.speed);
    const kmh = absSpeed * 3.6;

    // ---- steering (speed sensitive) ----
    const sf = clampN(absSpeed / C.TOP_SPEED, 0, 1);
    let maxSteer = lerpN(C.MAX_STEER_LOW, C.MAX_STEER_HIGH, Math.sqrt(sf));
    if (this.drifting) maxSteer = maxSteer * 1.6;
    this.steerAngle = moveTowards(this.steerAngle, inp.steer * maxSteer, C.STEER_RATE * dt * Math.max(maxSteer, 0.2));

    // ---- nitro ----
    this.nitroActive = false;
    if (inp.nitro && this.nitro > 0.01 && this.grounded >= 2 && this.speed > 2) {
      this.nitroActive = true;
      this.nitro = Math.max(0, this.nitro - C.NITRO_BURN * dt);
    }

    // ---- suspension + lateral tyre forces per wheel ----
    const k = (m / 4) * (2 * Math.PI * SUSP_FREQ) * (2 * Math.PI * SUSP_FREQ);
    const c = 2 * SUSP_ZETA * Math.sqrt(k * m / 4);
    const w = tmpW;
    fast.bodyAngularVelocity(this.body, w);
    const cosS = Math.cos(this.steerAngle), sinS = Math.sin(this.steerAngle);
    let grounded = 0;
    let onRoad = 0;
    let offroad = 0;
    // Rear slip angle (for drift detection)
    let rearLatV = 0;
    let rearLongV = 0;
    const handbrake = inp.handbrake;

    // drift state: entered with handbrake (or hard steer at speed), held while sliding
    for (let i = 0; i < 4; i++) {
      // hardpoint in world
      qRotate(this.rot, WX[i], HARDPOINT_Y, WZ[i], tmpA);
      const hx = this.pos.x + tmpA.x, hy = this.pos.y + tmpA.y, hz = this.pos.z + tmpA.z;
      if (!fast.raycast(this.world, hx, hy, hz, -this.up.x, -this.up.y, -this.up.z, RAY_LEN, 0x1)) {
        this.wheelCompression[i] = 0;
        continue;
      }
      const dist = fast.rayHitFraction() * RAY_LEN;
      const susLen = dist - C.WHEEL_RADIUS;
      let compression = REST_LEN - susLen;
      if (compression < 0) compression = 0;
      this.wheelCompression[i] = compression;
      grounded++;
      let surfaceGrip = 1.0;
      if (fast.rayHitBody() === trackRoad) onRoad++;
      else { offroad++; surfaceGrip = C.OFFROAD_GRIP / C.TYRE_GRIP; }

      // point velocity at the hardpoint
      const rx = tmpA.x, ry = tmpA.y, rz = tmpA.z;
      const pvx = this.vel.x + (w.y * rz - w.z * ry);
      const pvy = this.vel.y + (w.z * rx - w.x * rz);
      const pvz = this.vel.z + (w.x * ry - w.y * rx);
      const vUp = pvx * this.up.x + pvy * this.up.y + pvz * this.up.z;
      let fs = k * compression - c * vUp;
      if (fs < 0) fs = 0;
      if (fs > m * GRAVITY * 1.5) fs = m * GRAVITY * 1.5;
      fast.addForceAt(this.body, this.up.x * fs, this.up.y * fs, this.up.z * fs, hx, hy, hz);

      // wheel axes (front wheels steer)
      let wfx = this.fwd.x, wfy = this.fwd.y, wfz = this.fwd.z;
      let wrx = this.right.x, wry = this.right.y, wrz = this.right.z;
      if (i < 2) {
        wfx = this.fwd.x * cosS + this.right.x * sinS;
        wfy = this.fwd.y * cosS + this.right.y * sinS;
        wfz = this.fwd.z * cosS + this.right.z * sinS;
        wrx = this.right.x * cosS - this.fwd.x * sinS;
        wry = this.right.y * cosS - this.fwd.y * sinS;
        wrz = this.right.z * cosS - this.fwd.z * sinS;
      }
      const vLat = pvx * wrx + pvy * wry + pvz * wrz;
      const vLong = pvx * wfx + pvy * wfy + pvz * wfz;
      if (i >= 2) { rearLatV += vLat; rearLongV += vLong; }
      this.wheelSpin[i] += (vLong / C.WHEEL_RADIUS) * dt;

      let grip = C.TYRE_GRIP * surfaceGrip;
      if (i >= 2) {
        if (handbrake && absSpeed > 4) grip = grip * C.HANDBRAKE_REAR_GRIP;
        else if (this.drifting) grip = grip * C.DRIFT_REAR_GRIP;
      }
      const load = Math.max(fs, m * GRAVITY * 0.12);
      const maxF = grip * load;
      let fLat = -vLat * (m / 4) / dt * 0.4;
      if (fLat > maxF) fLat = maxF;
      if (fLat < -maxF) fLat = -maxF;
      // apply at centre-of-mass height to avoid excessive body roll
      qRotate(this.rot, WX[i], 0.38, WZ[i], tmpA);
      fast.addForceAt(this.body, wrx * fLat, wry * fLat, wrz * fLat,
        this.pos.x + tmpA.x, this.pos.y + tmpA.y, this.pos.z + tmpA.z);
    }
    this.grounded = grounded;
    this.onRoad = onRoad;

    // ---- drift detection ----
    this.slipAngle = 0;
    if (Math.abs(rearLongV) > 1) this.slipAngle = Math.atan2(rearLatV, Math.abs(rearLongV));
    const absSlip = Math.abs(this.slipAngle);
    if (!this.drifting) {
      if (absSpeed > 12 && grounded >= 2 && ((handbrake && Math.abs(inp.steer) > 0.2) || absSlip > 0.22)) this.drifting = true;
    } else if (absSlip < 0.07 || absSpeed < 8 || grounded < 2) {
      this.drifting = false;
    }
    let targetDrift = 0;
    if (this.drifting) targetDrift = clampN(absSlip / 0.5, 0.2, 1);
    this.driftAmount = lerpN(this.driftAmount, targetDrift, 0.15);
    if (this.drifting && grounded >= 2) {
      this.nitro = Math.min(C.NITRO_MAX, this.nitro + C.NITRO_DRIFT_GAIN * dt * clampN(absSlip / 0.35, 0.3, 1.2));
      // Arcade drift assist: steer controls yaw directly, velocity bends toward heading.
      fast.addTorque(this.body, this.up.x * inp.steer * -m * 4, this.up.y * inp.steer * -m * 4, this.up.z * inp.steer * -m * 4);
    }

    // ---- longitudinal (drive / brake / drag), applied at COM ----
    const shiftedTopSpeed = this.nitroActive ? C.NITRO_TOP_SPEED : C.ENGINE_VMAX;
    let accel = 0;
    this.braking = false;
    if (grounded >= 2) {
      if (inp.throttle > 0.01 && this.speed > -1) {
        const x = clampN(this.speed / shiftedTopSpeed, 0, 1.2);
        let a = C.ENGINE_ACCEL * (1 - x * x * x);
        if (this.shiftTimer > 0) a = a * 0.4;
        if (this.nitroActive) a += C.NITRO_ACCEL * clampN(1 - this.speed / C.NITRO_TOP_SPEED, 0, 1) + 2;
        accel += a * inp.throttle;
      }
      if (inp.brake > 0.01) {
        if (this.speed > 1.0) {
          accel -= C.BRAKE_DECEL * inp.brake;
          this.braking = true;
        } else if (this.speed > -C.REVERSE_SPEED) {
          accel -= 6 * inp.brake; // reverse
        }
      }
      if (handbrake && this.speed > 0.5) accel -= 3;
      // drag
      let drag = C.ROLL_DRAG + C.AIR_DRAG * this.speed * this.speed;
      if (offroad > 0) drag += C.OFFROAD_DRAG * (offroad / 4) * clampN(absSpeed / 10, 0, 1) * 2;
      if (this.speed > shiftedTopSpeed) drag += (this.speed - shiftedTopSpeed) * 1.5; // after nitro ends
      if (this.speed > 0.2) accel -= drag;
      else if (this.speed < -0.2) accel += drag;
      // downforce keeps the car planted over crests
      const df = m * 0.0016 * this.speed * this.speed;
      fast.addForce(this.body,
        this.fwd.x * accel * m - this.up.x * df,
        this.fwd.y * accel * m - this.up.y * df,
        this.fwd.z * accel * m - this.up.z * df);
      if (this.drifting) {
        // keep momentum in a drift: rotate a bit of sideways velocity into forward
        const lat = this.vel.x * this.right.x + this.vel.z * this.right.z;
        const f = m * lat * 0.9;
        fast.addForce(this.body,
          (-this.right.x * f) + this.fwd.x * Math.abs(f) * 0.55,
          0,
          (-this.right.z * f) + this.fwd.z * Math.abs(f) * 0.55);
      }
    }

    // ---- stability: keep the car upright (arcade) ----
    // torque ~ up × worldUp, plus damping of roll/pitch rates
    const ux = this.up.x, uy = this.up.y, uz = this.up.z;
    // cross(up, Y) = (uy*0 - uz*1, uz*0 - ux*0, ux*1 - uy*0) = (-uz, 0, ux)
    let kUp = m * 6;
    if (grounded === 0) kUp = m * 10;
    const yawRate = w.x * ux + w.y * uy + w.z * uz;
    const wpx = w.x - ux * yawRate, wpy = w.y - uy * yawRate, wpz = w.z - uz * yawRate;
    const dRate = m * 1.2;
    fast.addTorque(this.body,
      -uz * kUp - wpx * dRate,
      -wpy * dRate,
      ux * kUp - wpz * dRate);

    // ---- gears / rpm (cosmetic + audio) ----
    this.justShifted = false;
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    let g = 1;
    while (g < 6 && kmh > C.GEAR_TOP_KMH[g] * 0.97) g++;
    if (this.speed < -0.5) g = 1;
    if (g !== this.gear) {
      if (g > this.gear) { this.shiftTimer = C.SHIFT_TIME; this.justShifted = true; this.shiftCount += 1; } // not ++ (Perry wasm no-op)
      this.gear = g;
    }
    let targetRpm = C.IDLE_RPM;
    const lo = C.GEAR_TOP_KMH[g - 1] * 0.97;
    const hi = C.GEAR_TOP_KMH[g];
    let frac = clampN((kmh - lo) / (hi - lo), 0, 1);
    if (g === 1) targetRpm = C.IDLE_RPM + frac * (C.REDLINE_RPM - C.IDLE_RPM);
    else targetRpm = C.REDLINE_RPM * clampN(kmh / hi, 0, 1.05);
    if (grounded === 0 && inp.throttle > 0.5) targetRpm = C.REDLINE_RPM * 0.95;
    if (inp.throttle < 0.05 && g === 1 && kmh < 5) targetRpm = C.IDLE_RPM;
    if (targetRpm < C.IDLE_RPM) targetRpm = C.IDLE_RPM;
    if (this.shiftTimer > 0) frac = 0;
    this.rpm = lerpN(this.rpm, targetRpm, this.justShifted ? 0.6 : 0.25);
  }

  /** Update scene-node transforms, interpolating between physics states. */
  updateVisuals(alpha: number): void {
    if (this.nodes.length === 0) return;
    qNlerp(this.prevRot, this.rot, alpha, this.renderRot);
    const px = lerpN(this.prevPos.x, this.pos.x, alpha);
    const py = lerpN(this.prevPos.y, this.pos.y, alpha);
    const pz = lerpN(this.prevPos.z, this.pos.z, alpha);
    const car = mat4FromQT(this.renderRot, px, py, pz, this.m4car);
    for (let i = 0; i < 5; i++) setSceneNodeTransform(this.nodes[i], car);
    setSceneNodeTransform(this.nodes[PRIM_BRAKE], car);
    if (this.braking !== this.brakeLit) this.setBrakeLights(this.braking);

    // wheels: car * T(wheel) * Rsteer * Rspin * T(-wheel)
    for (let wi = 0; wi < 4; wi++) {
      const wx = WX[wi], wz = WZ[wi];
      const wy = C.WHEEL_RADIUS + clampN(this.wheelCompression[wi] - STATIC_COMPRESSION, -0.15, 0.2);
      const spin = -this.wheelSpin[wi];
      const steer = wi < 2 ? -this.steerAngle : 0;
      // R = Ry(steer) * Rx(spin)
      const cy = Math.cos(steer), sy = Math.sin(steer);
      const cx = Math.cos(spin), sx = Math.sin(spin);
      const m = this.m4a;
      // column-major: columns are images of basis vectors
      // Rx: X->(1,0,0), Y->(0,cx,sx), Z->(0,-sx,cx); then Ry applied
      m[0] = cy; m[1] = 0; m[2] = -sy; m[3] = 0;
      m[4] = sy * sx; m[5] = cx; m[6] = cy * sx; m[7] = 0;
      m[8] = sy * cx; m[9] = -sx; m[10] = cy * cx; m[11] = 0;
      // translation: T(w) * R * T(-w0): w = (wx, wy, wz), w0 = (wx, 0.34, wz) source position
      const w0y = C.WHEEL_RADIUS;
      m[12] = wx - (m[0] * wx + m[4] * w0y + m[8] * wz);
      m[13] = wy - (m[1] * wx + m[5] * w0y + m[9] * wz);
      m[14] = wz - (m[2] * wx + m[6] * w0y + m[10] * wz);
      m[15] = 1;
      mat4Mul(car, m, this.m4b);
      const start = WHEEL_PRIM_START[wi];
      for (let p = 0; p < 3; p++) setSceneNodeTransform(this.nodes[start + p], this.m4b);
    }
  }

  renderPos(alpha: number, out: V3): V3 {
    out.x = lerpN(this.prevPos.x, this.pos.x, alpha);
    out.y = lerpN(this.prevPos.y, this.pos.y, alpha);
    out.z = lerpN(this.prevPos.z, this.pos.z, alpha);
    return out;
  }

  renderRotation(alpha: number, out: Q4): Q4 {
    return qNlerp(this.prevRot, this.rot, alpha, out);
  }

  kmh(): number { return Math.abs(this.speed) * 3.6; }
}
