// Race rules: checkpoints in order, laps, positions, drafting, resets.
import { Car } from "./vehicle";
import * as C from "./config";
import {
  NUM_CP, cpAlong, cpAcross, cpHalfWidth, cpX, cpY, cpZ, cpFX, cpFZ,
  spawnPos, spawnRot, nearestLineIndex,
} from "./track";
import { qFromYaw } from "./util/math3d";
import { loadBestLap, saveBestLap } from "./storage";

export const Phase = { Menu: 0, Countdown: 1, Racing: 2, Finished: 3 };

export interface RaceEvents {
  lapCompleted: boolean;     // player completed a lap this step
  newBest: boolean;
  playerFinished: boolean;
  wrongCheckpoint: boolean;
}

export class Race {
  cars: Car[] = [];
  phase: number = Phase.Menu;
  paused = false;
  countdown = 0;
  raceTime = 0;
  bestLapEver = 0;          // persisted
  finishOrder: Car[] = [];
  events: RaceEvents = { lapCompleted: false, newBest: false, playerFinished: false, wrongCheckpoint: false };
  playerPosition = 1;
  persistBest = true;
  private order: Car[] = [];

  constructor() {
    this.bestLapEver = loadBestLap();
  }

  player(): Car { return this.cars[0]; }

  /** Put all cars on the grid and reset race state. */
  setupGrid(): void {
    this.raceTime = 0;
    this.finishOrder = [];
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      car.spawn(spawnPos(i), spawnRot(i));
      car.nextCp = 0;
      car.lastCp = -1;
      car.cpTotal = 0;
      car.lap = 1;
      car.finished = false;
      car.finishTime = 0;
      car.lapStart = 0;
      car.lastLapTime = 0;
      car.bestLapTime = 0;
      car.lapTimes = [];
      car.nitro = C.NITRO_START;
      car.lineIdx = -1;
      car.started = false;
    }
    this.order = this.cars.slice(0);
  }

  startCountdown(): void {
    this.phase = Phase.Countdown;
    this.countdown = 3.999;
  }

  /** Per fixed step, after the physics step. */
  stepRules(dt: number): void {
    this.events.lapCompleted = false;
    this.events.newBest = false;
    this.events.playerFinished = false;
    if (this.phase === Phase.Racing || this.phase === Phase.Finished) this.raceTime += dt;
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      car.lineIdx = nearestLineIndex(car.pos.x, car.pos.z, car.lineIdx, 12);
      if (this.phase === Phase.Racing || this.phase === Phase.Finished) {
        this.checkCheckpoint(car);
        this.checkDraft(car, dt);
        this.checkAutoReset(car, dt);
      }
    }
    this.rank();
  }

  checkCheckpoint(car: Car): void {
    const cp = car.nextCp;
    const a0 = cpAlong(cp, car.prevPos.x, car.prevPos.z);
    const a1 = cpAlong(cp, car.pos.x, car.pos.z);
    if (!(a0 < 0 && a1 >= 0)) return;
    const across = Math.abs(cpAcross(cp, car.pos.x, car.pos.z));
    if (across > cpHalfWidth(cp) + 1.5) return;
    if (Math.abs(car.pos.y - cpY(cp)) > cpHeightTol) return;
    // crossed the expected checkpoint
    // `+= 1`, not `++`: Perry's wasm target drops postfix ++ on a member (no-op)
    car.cpTotal += 1;
    car.lastCp = cp;
    car.nextCp = (cp + 1) % NUM_CP;
    if (cp !== 0) return;
    if (!car.started) { car.started = true; return; } // first crossing of the start line
    if (car.finished) return;
    const lapTime = this.raceTime - car.lapStart;
    car.lapStart = this.raceTime;
    car.lastLapTime = lapTime;
    car.lapTimes.push(lapTime);
    if (car.bestLapTime === 0 || lapTime < car.bestLapTime) car.bestLapTime = lapTime;
    if (car.isPlayer) {
      this.events.lapCompleted = true;
      if (this.bestLapEver === 0 || lapTime < this.bestLapEver) {
        this.bestLapEver = lapTime;
        this.events.newBest = true;
        if (this.persistBest) saveBestLap(lapTime);
      }
    }
    if (car.lap >= C.TOTAL_LAPS) {
      car.finished = true;
      car.finishTime = this.raceTime;
      const order = this.finishOrder; // alias: Perry wasm drops this.field.push (see vehicle.ts)
      order.push(car);
      if (car.isPlayer) {
        this.events.playerFinished = true;
        this.phase = Phase.Finished;
      }
    } else {
      car.lap += 1;
    }
  }

  private checkDraft(car: Car, dt: number): void {
    car.draftTimer = 0;
    if (car.speed < 16) return;
    for (let j = 0; j < this.cars.length; j++) {
      const o = this.cars[j];
      if (o === car) continue;
      const dx = o.pos.x - car.pos.x, dz = o.pos.z - car.pos.z;
      const along = dx * car.fwd.x + dz * car.fwd.z;
      if (along < 3 || along > 28) continue;
      const lat = dx * car.right.x + dz * car.right.z;
      if (Math.abs(lat) > 3.2) continue;
      car.draftTimer = 1;
      car.nitro = Math.min(C.NITRO_MAX, car.nitro + C.NITRO_DRAFT_GAIN * dt * (1.4 - along / 28));
      return;
    }
  }

  private checkAutoReset(car: Car, dt: number): void {
    if (car.onRoad === 0) car.offTrackTimer += dt;
    else car.offTrackTimer = 0;
    if (car.up.y < 0.35) car.flipTimer += dt;
    else car.flipTimer = 0;
    const fell = car.pos.y < cpY(0) - 40;
    if (car.offTrackTimer > C.RESET_AFTER || car.flipTimer > C.RESET_AFTER || fell) this.resetCar(car);
  }

  /** Move a car back to its last checkpoint (or its grid slot before the first one). */
  resetCar(car: Car): void {
    const cp = car.lastCp;
    if (cp < 0) {
      car.spawn(spawnPos(car.index), spawnRot(car.index));
      return;
    }
    const fx = cpFX(cp), fz = cpFZ(cp);
    // lateral slot so simultaneous resets don't stack cars on top of each other
    let lat = 0;
    if (car.index === 1) lat = 3.5;
    if (car.index === 2) lat = -3.5;
    if (car.index === 3) lat = 1.75;
    const rx = -fz, rz = fx;
    const yaw = Math.atan2(-fx, -fz);
    car.spawn({ x: cpX(cp) + rx * lat + fx * 2, y: cpY(cp) + 0.4, z: cpZ(cp) + rz * lat + fz * 2 }, qFromYaw(yaw));
    car.lineIdx = -1;
    car.lineIdx = nearestLineIndex(car.pos.x, car.pos.z, -1, 0);
  }

  /** Sort cars: finishers by finish order, then by checkpoint progress. */
  private rank(): void {
    const o = this.order;
    // insertion sort (4 cars)
    for (let i = 1; i < o.length; i++) {
      const c = o[i];
      let j = i - 1;
      while (j >= 0 && this.ahead(c, o[j])) { o[j + 1] = o[j]; j--; }
      o[j + 1] = c;
    }
    for (let i = 0; i < o.length; i++) {
      o[i].position = i + 1;
      if (o[i].isPlayer && !o[i].finished) this.playerPosition = i + 1;
      if (o[i].isPlayer && o[i].finished) this.playerPosition = this.finishOrder.indexOf(o[i]) + 1;
    }
  }

  private ahead(a: Car, b: Car): boolean {
    if (a.finished && b.finished) return this.finishOrder.indexOf(a) < this.finishOrder.indexOf(b);
    if (a.finished) return true;
    if (b.finished) return false;
    const sa = this.progress(a), sb = this.progress(b);
    return sa > sb;
  }

  progress(c: Car): number {
    const cp = c.nextCp;
    const dx = cpX(cp) - c.pos.x, dz = cpZ(cp) - c.pos.z;
    return c.cpTotal * 100000 - Math.sqrt(dx * dx + dz * dz);
  }

  standings(): Car[] { return this.order; }
}

const cpHeightTol = 8;
