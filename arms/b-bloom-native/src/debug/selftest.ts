// Scripted gameplay self-test, run with `--selftest` (implies --autostart).
// Exercises Definition-of-Done items that are hard to verify by eye and
// prints PASS/FAIL lines. Runs inside the real game loop and physics.
import * as physics from "bloom/physics";
import { Car } from "../vehicle";
import { Race } from "../race";
import { NUM_CP, cpX, cpY, cpZ, cpFX, cpFZ, lineX, lineY, lineZ, wrapIndex } from "../track";
import { qFromYaw } from "../util/math3d";
import { TOTAL_LAPS } from "../config";
import { driveAI } from "../ai";

let step = 0;
let timer = 0;
let passes = 0;
let fails = 0;
let saved = 0;
let saved2 = 0;
let peak = 0;
export let selftestDone = false;

function report(name: string, ok: boolean, detail: string): void {
  if (ok) passes++; else fails++;
  console.log((ok ? "PASS " : "FAIL ") + name + " - " + detail);
}

/** Simulate a crossing of checkpoint i (car moves 3 m before -> 3 m after). */
function crossCp(race: Race, car: Car, i: number): void {
  car.prevPos.x = cpX(i) - cpFX(i) * 3; car.prevPos.z = cpZ(i) - cpFZ(i) * 3; car.prevPos.y = cpY(i);
  car.pos.x = cpX(i) + cpFX(i) * 3; car.pos.z = cpZ(i) + cpFZ(i) * 3; car.pos.y = cpY(i);
  race.checkCheckpoint(car);
}

function placeOnLine(car: Car, idx: number, lateral: number, speed: number): void {
  const i = wrapIndex(idx), j = wrapIndex(idx + 1);
  let tx = lineX[j] - lineX[i], tz = lineZ[j] - lineZ[i];
  const tl = Math.sqrt(tx * tx + tz * tz);
  tx /= tl; tz /= tl;
  const yaw = Math.atan2(-tx, -tz);
  car.spawn({ x: lineX[i] + (-tz) * lateral, y: lineY[i] + 0.05, z: lineZ[i] + tx * lateral }, qFromYaw(yaw));
  physics.setLinearVelocity(car.body, { x: tx * speed, y: 0, z: tz * speed });
}

function idle(car: Car): void {
  car.input.throttle = 0; car.input.brake = 0; car.input.steer = 0;
  car.input.handbrake = false; car.input.nitro = false;
}

/** Called once per frame while the race is running. Returns true when the player input was set. */
export function updateSelftest(race: Race, dt: number, requestReset: () => void): boolean {
  if (selftestDone) return false;
  const car = race.player();
  timer += dt;
  idle(car);
  switch (step) {
    case 0: { // ---- checkpoint order / shortcut prevention (pure rules) ----
      // Start state: car behind the line, nextCp = 0.
      const lap0 = car.lap;
      crossCp(race, car, 0);                      // start-line crossing
      // shortcut: skip cp_01..cp_07 and jump straight to cp_08 and the line
      crossCp(race, car, 8);
      crossCp(race, car, 0);
      const skipped = car.lap === lap0 && car.lapTimes.length === 0 && car.nextCp === 1;
      report("checkpoints: skipping cp_01..07 does not count a lap", skipped,
        "lap=" + car.lap + " nextCp=" + car.nextCp + " laps recorded=" + car.lapTimes.length);
      // reverse order does not count either
      crossCp(race, car, 2);
      const rev = car.nextCp === 1;
      report("checkpoints: out-of-order cp_02 ignored", rev, "nextCp=" + car.nextCp);
      // proper order completes the lap
      for (let i = 1; i < NUM_CP; i++) crossCp(race, car, i);
      crossCp(race, car, 0);
      report("checkpoints: all 16 in order count a lap", car.lap === lap0 + 1 && car.lapTimes.length === 1,
        "lap=" + car.lap + " laps recorded=" + car.lapTimes.length);
      // finish after TOTAL_LAPS
      for (let l = car.lap; l <= TOTAL_LAPS; l++) {
        for (let i = 1; i < NUM_CP; i++) crossCp(race, car, i);
        crossCp(race, car, 0);
      }
      report("race: finishes after " + TOTAL_LAPS + " laps", car.finished && car.lapTimes.length === TOTAL_LAPS,
        "finished=" + car.finished + " laps=" + car.lapTimes.length);
      // restore race state for the physical tests
      race.setupGrid();
      race.phase = 2;
      car.lastCp = 3; car.nextCp = 4; car.started = true;
      step = 1; timer = 0;
      return true;
    }
    case 1: { // ---- manual reset: put the car on the grass, sideways, then press R ----
      if (timer < 0.05) { placeOnLine(car, 120, 11, 0); }
      if (timer > 0.6 && timer < 0.7) {
        requestReset();
        const dx = car.pos.x - (cpX(3) + cpFX(3) * 2), dz = car.pos.z - (cpZ(3) + cpFZ(3) * 2);
        const d = Math.sqrt(dx * dx + dz * dz);
        report("reset: manual reset returns to last checkpoint (cp_03)", d < 5, "distance to cp_03 slot=" + Math.round(d * 10) / 10 + "m");
        step = 2; timer = 0;
      }
      return true;
    }
    case 2: { // ---- auto reset when upside down > 3 s ----
      if (timer < 0.05) {
        placeOnLine(car, 40, 0, 0);
        const p = car.pos;
        physics.setBodyTransform(car.body, { position: { x: p.x, y: p.y + 1.5, z: p.z }, rotation: { x: 0, y: 0, z: 1, w: 0 } }, true);
        saved = 0;
      }
      if (saved === 0 && timer > 0.5 && car.up.y < 0) saved = timer; // confirmed flipped
      if (timer > 4.2) {
        report("reset: auto reset when upside down > 3 s", saved > 0 && car.up.y > 0.9 && car.flipTimer < 1,
          "flipped at t=" + Math.round(saved * 10) / 10 + " now up.y=" + Math.round(car.up.y * 100) / 100);
        step = 3; timer = 0;
      }
      return true;
    }
    case 3: { // ---- auto reset when off track > 3 s ----
      if (timer < 0.05) { placeOnLine(car, 200, 10.5, 0); saved = 0; }
      if (timer > 0.5 && saved === 0) saved = car.onRoad === 0 ? 1 : -1;
      if (timer > 4.0) {
        report("reset: auto reset when off track > 3 s", saved === 1 && car.onRoad >= 2,
          "was off-road=" + (saved === 1) + " now wheels on road=" + car.onRoad);
        step = 4; timer = 0;
      }
      return true;
    }
    case 4: { // ---- drift fills nitro ----
      if (timer < 0.05) { placeOnLine(car, 30, 0, 33); car.nitro = 0.1; saved = 0.1; saved2 = 0; }
      car.input.throttle = 1;
      if (timer > 0.3) { car.input.steer = -1; car.input.handbrake = timer < 0.9; }
      if (car.drifting) saved2 += dt;
      if (timer > 2.0) {
        report("nitro: drifting fills the nitro bar", car.nitro > saved + 0.05 && saved2 > 0.3,
          "drift time=" + Math.round(saved2 * 100) / 100 + "s nitro " + saved + " -> " + Math.round(car.nitro * 100) / 100);
        step = 5; timer = 0;
      }
      return true;
    }
    case 5: { // ---- slipstream fills nitro ----
      if (timer < 0.05) {
        placeOnLine(car, 5, 0, 40);
        placeOnLine(race.cars[1], 8, 0, 40);
        car.nitro = 0.1;
      }
      car.input.throttle = 0.6;
      const o = race.cars[1];
      o.input.throttle = 0.6; o.input.steer = 0; o.input.brake = 0; o.input.nitro = false; o.input.handbrake = false;
      if (timer > 1.5) {
        report("nitro: slipstreaming behind an opponent fills the bar", car.nitro > 0.15,
          "nitro 0.1 -> " + Math.round(car.nitro * 100) / 100);
        step = 6; timer = 0;
      }
      return true;
    }
    case 6: { // ---- nitro gives a clear burst: compare 2 s with and without ----
      if (timer < 0.05) { placeOnLine(car, 0, 0, 40); car.nitro = 1; }
      car.input.throttle = 1;
      if (timer > 2.0) {
        saved = car.speed; step = 7; timer = 0;
      }
      return true;
    }
    case 7: {
      if (timer < 0.05) { placeOnLine(car, 0, 0, 40); car.nitro = 1; }
      car.input.throttle = 1; car.input.nitro = true;
      if (timer > 2.0) {
        const gain = (car.speed - saved) * 3.6;
        report("nitro: boost gives a clear speed burst", gain > 15,
          "after 2 s: no nitro " + Math.round(saved * 3.6) + " km/h, nitro " + Math.round(car.speed * 3.6) + " km/h (+" + Math.round(gain) + ")");
        step = 8; timer = 0;
      }
      return true;
    }
    case 8: { // ---- top speed ~250 km/h without nitro (main straight) ----
      if (timer < 0.05) { placeOnLine(car, -66, 0, 60); car.nitro = 0; saved2 = 0; peak = 0; }
      if (car.kmh() > peak) peak = car.kmh();
      driveAI(car, race.cars, 0, 0, dt);   // AI only steers here
      car.input.throttle = 1; car.input.brake = 0; car.input.nitro = false;
      if (timer > saved2) {
        saved2 += 0.5;
        console.log("  trace t=" + Math.round(timer * 10) / 10 + " kmh=" + Math.round(car.kmh()) + " onRoad=" + car.onRoad + " grounded=" + car.grounded + " drift=" + car.drifting + " gear=" + car.gear + " y=" + Math.round(car.pos.y * 100) / 100 + " slip=" + Math.round(car.slipAngle * 100) / 100);
      }
      if (timer > 4.6) {
        report("handling: top speed ~250 km/h (no nitro)", peak > 240 && peak < 262, "peak flat-out speed on the main straight=" + Math.round(peak) + " km/h");
        console.log("SELFTEST DONE pass=" + passes + " fail=" + fails);
        selftestDone = true;
      }
      return true;
    }
  }
  return true;
}
