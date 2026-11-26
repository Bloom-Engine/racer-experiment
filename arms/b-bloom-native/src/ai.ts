// AI drivers: follow the racing line from the manifest with per-driver
// variation, brake from the line's speed profile, avoid/overtake other cars
// (including the player — they are physical, never ghosts) and use nitro on
// straights. Mild rubber-banding keeps them beatable but not trivial.
import { Car } from "./vehicle";
import { lineX, lineZ, lineSpeed, wrapIndex } from "./track";
import { clampN, lerpN } from "./util/math3d";
import * as C from "./config";

interface AIState {
  skill: number;        // fraction of line speed
  offsetBias: number;   // preferred lateral offset (m)
  wobbleFreq: number;
  wobblePhase: number;
  avoidOffset: number;  // current avoidance offset (m)
  stuckTimer: number;
  reverseTimer: number;
  nitroHold: boolean;
  revSteer: number;
}

const states: AIState[] = [];

/** Difficulty multiplier (1 = normal). */
export let aiDifficulty = 1.0;

export function initAI(numCars: number): void {
  states.length = 0;
  const skills: number[] = [1.0, 0.985, 0.955, 0.93];
  const bias: number[] = [0, 0.8, -1.2, 0.4];
  for (let i = 0; i < numCars; i++) {
    states.push({
      skill: skills[i % 4],
      offsetBias: bias[i % 4],
      wobbleFreq: 0.05 + 0.03 * i,
      wobblePhase: i * 1.7,
      avoidOffset: 0,
      stuckTimer: 0,
      reverseTimer: 0,
      nitroHold: false,
      revSteer: 1,
    });
  }
}

function maxSteerFor(speed: number): number {
  const sf = clampN(Math.abs(speed) / C.TOP_SPEED, 0, 1);
  return lerpN(C.MAX_STEER_LOW, C.MAX_STEER_HIGH, Math.sqrt(sf));
}

/**
 * Compute driving input for an AI car. `leaderGap` = metres the player is
 * ahead (+) or behind (-) of this car, used for rubber-banding.
 */
export function driveAI(car: Car, cars: Car[], time: number, leaderGap: number, dt: number): void {
  const st = states[car.index];
  const inp = car.input;
  const idx = car.lineIdx < 0 ? 0 : car.lineIdx;
  const speed = car.speed;

  // ---- stuck recovery ----
  if (st.reverseTimer > 0) {
    st.reverseTimer -= dt;
    inp.throttle = 0; inp.brake = 1; inp.handbrake = false; inp.nitro = false;
    inp.steer = st.revSteer;
    return;
  }
  if (Math.abs(speed) < 2) st.stuckTimer += dt;
  else st.stuckTimer = 0;
  if (st.stuckTimer > 2.0) {
    st.stuckTimer = 0;
    st.reverseTimer = 1.2;
    st.revSteer = inp.steer > 0 ? -1 : 1;
  }

  // ---- lateral target offset (variation + avoidance) ----
  let desired = st.offsetBias + Math.sin(time * st.wobbleFreq * Math.PI * 2 + st.wobblePhase) * 1.2;
  let avoid = 0;
  let blockSpeed = 1e9;
  for (let j = 0; j < cars.length; j++) {
    const o = cars[j];
    if (o === car) continue;
    const dx = o.pos.x - car.pos.x, dz = o.pos.z - car.pos.z;
    const along = dx * car.fwd.x + dz * car.fwd.z;
    if (along < -2 || along > 26) continue;
    const lat = dx * car.right.x + dz * car.right.z;
    if (Math.abs(lat) > 3.4) continue;
    // car in our path: move to the other side, harder when close
    const urgency = 1 - along / 26;
    let side = 1;
    if (lat > 0) side = -1;
    avoid += side * (3.6 - Math.abs(lat)) * urgency * 1.3;
    const closing = speed - o.speed;
    if (along < 9 && closing > 2 && Math.abs(lat) < 2.2) blockSpeed = Math.min(blockSpeed, o.speed);
  }
  st.avoidOffset = lerpN(st.avoidOffset, avoid, 0.08);
  desired += st.avoidOffset;

  // ---- look-ahead target on the racing line ----
  const look = 7 + Math.max(speed, 0) * 0.42;
  const la = Math.max(2, Math.round(look / 5));
  const ti = wrapIndex(idx + la);
  const tn = wrapIndex(ti + 1), tp = wrapIndex(ti - 1);
  let tx = lineX[tn] - lineX[tp], tz = lineZ[tn] - lineZ[tp];
  const tl = Math.sqrt(tx * tx + tz * tz) + 1e-6;
  tx /= tl; tz /= tl;
  // limit offset in slow corners (line hugs the edge there)
  const cornerFactor = clampN(lineSpeed[ti] / 45, 0.35, 1);
  const off = clampN(desired, -4.5, 4.5) * cornerFactor;
  const gx = lineX[ti] + (-tz) * off;
  const gz = lineZ[ti] + tx * off;
  const dx = gx - car.pos.x, dz = gz - car.pos.z;
  const fwdD = dx * car.fwd.x + dz * car.fwd.z;
  const rightD = dx * car.right.x + dz * car.right.z;
  const angle = Math.atan2(rightD, fwdD);
  inp.steer = clampN((angle / maxSteerFor(speed)) * 1.15, -1, 1);
  inp.handbrake = false;

  // ---- speed target from the line profile (braking distance aware) ----
  let rubber = 1.0;
  if (leaderGap > 60) rubber = 1.0 + clampN((leaderGap - 60) / 400, 0, 0.06);      // player ahead: push
  if (leaderGap < -80) rubber = 1.0 - clampN((-leaderGap - 80) / 500, 0, 0.08);   // player behind: ease
  const skill = st.skill * rubber * aiDifficulty;
  let target = 1e9;
  const decel = 13;
  for (let k = 0; k < 40; k++) {
    const i = wrapIndex(idx + k);
    const d = k * 5;
    const vAllowed = Math.sqrt(lineSpeed[i] * skill * lineSpeed[i] * skill + 2 * decel * d);
    if (vAllowed < target) target = vAllowed;
  }
  if (target > C.TOP_SPEED) target = C.TOP_SPEED + 2;
  if (blockSpeed < target) target = Math.max(blockSpeed - 0.5, 8);
  // don't charge into corners when the steering already saturates
  if (Math.abs(inp.steer) > 0.95 && speed > 20) target = Math.min(target, speed - 1);

  if (speed > target + 1.0) {
    inp.throttle = 0;
    inp.brake = clampN((speed - target) / 6, 0.2, 1);
  } else if (speed > target - 1.5) {
    inp.throttle = 0.35; inp.brake = 0;
  } else {
    inp.throttle = 1; inp.brake = 0;
  }

  // ---- nitro on long fast stretches ----
  let straightAhead = true;
  for (let k = 3; k < 28; k += 3) {
    if (lineSpeed[wrapIndex(idx + k)] < 50) { straightAhead = false; break; }
  }
  if (!st.nitroHold && car.nitro > 0.45 && straightAhead && speed > 25 && Math.abs(inp.steer) < 0.35) st.nitroHold = true;
  if (st.nitroHold && (car.nitro < 0.02 || !straightAhead)) st.nitroHold = false;
  inp.nitro = st.nitroHold;
}

/** Override one driver's skill (used for the autopilot player in tests). */
export function setAISkill(index: number, skill: number): void {
  if (index < states.length) states[index].skill = skill;
}
