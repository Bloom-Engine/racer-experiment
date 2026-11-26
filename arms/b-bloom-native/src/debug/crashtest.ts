// Deterministic wall-tunnelling test (Definition of Done #4), run with
// `--crashtest`. Each trial places the player car beside the start straight,
// aims it at the barrier at a given angle, launches it at 300 km/h (nitro top
// speed) with nitro held, and checks that it never ends up beyond the wall
// (wall distance measured with a raycast before launch).
import * as physics from "bloom/physics";
import { Car } from "../vehicle";
import { lineX, lineY, lineZ, wrapIndex } from "../track";
import { qFromYaw } from "../util/math3d";

const ANGLES_DEG: number[] = [90, 60, 45, 30, 75, 90, 50, 35, 90, 60];
const LAUNCH_SPEED = 300 / 3.6;

let trial = 0;
let timer = 0;
let launched = false;
let sx = 0, sz = 0, dirX = 0, dirZ = 0, wallDist = 0;
let nX = 0, nZ = 0, wallLat = 0;
let maxPen = -1e9;
let failures = 0;
let peakImpact = 0;
export let crashDone = false;

function setup(car: Car, world: number): void {
  const side = trial % 2 === 0 ? 1 : -1;     // alternate left/right walls
  const i = wrapIndex(14 + trial * 3);      // points along the start straight
  const j = wrapIndex(i + 1);
  let tx = lineX[j] - lineX[i], tz = lineZ[j] - lineZ[i];
  const tl = Math.sqrt(tx * tx + tz * tz);
  tx /= tl; tz /= tl;
  const rx = -tz, rz = tx;                   // right of the race direction
  const a = ANGLES_DEG[trial] * Math.PI / 180;
  dirX = tx * Math.cos(a) + rx * side * Math.sin(a);
  dirZ = tz * Math.cos(a) + rz * side * Math.sin(a);
  // start on the far side of the road so there is a run-up
  sx = lineX[i] - rx * side * 4;
  sz = lineZ[i] - rz * side * 4;
  const y = lineY[i];
  const hit = physics.raycast(world, { x: sx, y: y + 0.7, z: sz }, { x: dirX, y: 0, z: dirZ }, 200, 0x1);
  wallDist = hit === null ? 200 : hit.fraction * 200;
  // the barrier runs parallel to the straight: measure penetration along the
  // outward track normal, which is what "through the wall" means
  nX = rx * side; nZ = rz * side;
  wallLat = wallDist * (dirX * nX + dirZ * nZ);
  // car forward is -Z: yaw so that rotate(0,0,-1) = dir
  const yaw = Math.atan2(-dirX, -dirZ);
  car.spawn({ x: sx, y: y + 0.05, z: sz }, qFromYaw(yaw));
  physics.setLinearVelocity(car.body, { x: dirX * LAUNCH_SPEED, y: 0, z: dirZ * LAUNCH_SPEED });
  launched = true;
  timer = 0;
  maxPen = -1e9;
  peakImpact = 0;
}

/** Call once per frame while racing. Drives the player input too. */
export function updateCrashTest(car: Car, world: number, barriers: number, dt: number): void {
  if (crashDone) return;
  car.input.throttle = 1; car.input.brake = 0; car.input.steer = 0;
  car.input.handbrake = false; car.input.nitro = true; car.nitro = 1;
  if (!launched) { setup(car, world); return; }
  timer += dt;
  const lat = (car.pos.x - sx) * nX + (car.pos.z - sz) * nZ;
  const pen = lat - wallLat;      // > 0 means the car's centre is past the wall surface
  if (pen > maxPen) maxPen = pen;
  if (timer > 0.05 && car.impact > peakImpact) peakImpact = car.impact;
  if (timer > 1.6) {
    // Definitive check: is there a barrier between the launch point and the car?
    const ddx = car.pos.x - sx, ddz = car.pos.z - sz;
    const dl = Math.sqrt(ddx * ddx + ddz * ddz);
    let behindWall = false;
    if (dl > 0.5) {
      const h = physics.raycast(world, { x: sx, y: car.pos.y + 0.7, z: sz }, { x: ddx / dl, y: 0, z: ddz / dl }, dl, 0x1);
      if (h !== null && h.body === barriers) behindWall = true;
    }
    const ok = !behindWall;
    if (!ok) failures++;
    console.log("CRASH " + (trial + 1) + " angle=" + ANGLES_DEG[trial] + "deg launch=300km/h wallDist=" +
      Math.round(wallDist * 10) / 10 + "m peakDv=" + Math.round(peakImpact * 10) / 10 +
      "m/s maxLateralPastWallLine=" + Math.round(maxPen * 100) / 100 + "m barrierBetween=" + behindWall + " " + (ok ? "OK" : "TUNNELLED"));
    trial++;
    launched = false;
    if (trial >= ANGLES_DEG.length) {
      console.log("CRASHTEST DONE trials=" + trial + " tunnelled=" + failures);
      crashDone = true;
    }
  }
}
